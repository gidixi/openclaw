/**
 * Harmony stream wrapper for gpt-oss on Ollama.
 *
 * Problem: Ollama's Harmony parser cannot reverse-map tool calls from gpt-oss
 * back to OpenAI format. Every tool call is silently dropped, regardless of name.
 *
 * Solution: Bypass Ollama's Harmony parser entirely by:
 *  1. NOT sending tools in the API `tools` field
 *  2. Injecting tool definitions into the system prompt as plain text
 *  3. Parsing tool calls from the model's text output
 *  4. Emitting synthetic toolcall events so the agent loop dispatches them
 *
 * Conversation history handling:
 *  - AssistantMessage ToolCall blocks → converted to text with markers
 *  - ToolResultMessage → converted to user messages with result text
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Tool,
  ToolCall,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { logDebug, logWarn } from "../logger.js";
import { isGptOssOnOllama } from "./pi-tools.policy.js";

// Delimiters for text-mode tool calling.
// The model is instructed (via system prompt) to wrap tool calls in these markers.
const TOOL_CALL_START = "<tool_call>";
const TOOL_CALL_END = "</tool_call>";

// ---------------------------------------------------------------------------
// System prompt: tool definitions in plain text
// ---------------------------------------------------------------------------

function describeToolParameters(tool: Tool): string {
  // oxlint-disable-next-line typescript/no-explicit-any
  const schema = tool.parameters as any;
  if (!schema?.properties || typeof schema.properties !== "object") {
    return "  (no parameters)";
  }
  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties)
    .map(([name, prop]) => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const p = prop as any;
      const req = required.includes(name) ? "required" : "optional";
      const desc = p.description ? ` — ${p.description}` : "";
      const type = p.type ?? "any";
      return `  - ${name} (${type}, ${req})${desc}`;
    })
    .join("\n");
}

/**
 * Convert JSON Schema property to TypeScript-like type definition for Harmony format.
 * Harmony uses TypeScript-like syntax: type tool_name = (_: { param: type }) => any;
 */
function schemaPropertyToHarmonyType(prop: unknown, name: string, isRequired: boolean): string {
  // oxlint-disable-next-line typescript/no-explicit-any
  const p = prop as any;
  const type = p.type ?? "any";
  const desc = p.description ? ` // ${p.description}` : "";
  const optional = isRequired ? "" : "?";

  if (type === "string") {
    return `${name}${optional}: string${desc}`;
  } else if (type === "number" || type === "integer") {
    return `${name}${optional}: number${desc}`;
  } else if (type === "boolean") {
    return `${name}${optional}: boolean${desc}`;
  } else if (type === "array") {
    const items = p.items;
    if (items && items.type) {
      return `${name}${optional}: ${items.type}[]${desc}`;
    }
    return `${name}${optional}: any[]${desc}`;
  } else if (Array.isArray(p.enum)) {
    const enumValues = p.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
    return `${name}${optional}: ${enumValues}${desc}`;
  }
  return `${name}${optional}: any${desc}`;
}

function generateToolHarmonyDefinition(tool: Tool): string {
  // oxlint-disable-next-line typescript/no-explicit-any
  const schema = tool.parameters as any;
  const description = tool.description ? `// ${tool.description}` : "";

  if (!schema?.properties || typeof schema.properties !== "object") {
    // No parameters
    return `${description}\ntype ${tool.name} = () => any;`;
  }

  const required: string[] = Array.isArray(schema.required) ? schema.required : [];
  const properties: string[] = [];

  for (const [name, prop] of Object.entries(schema.properties)) {
    // oxlint-disable-next-line typescript/no-explicit-any
    const p = prop as any;
    const isRequired = required.includes(name);
    const typeDef = schemaPropertyToHarmonyType(prop, name, isRequired);
    properties.push(typeDef);
  }

  if (properties.length === 0) {
    return `${description}\ntype ${tool.name} = () => any;`;
  }

  const params = properties.join(",\n");
  return `${description}\ntype ${tool.name} = (_: {\n${params}\n}) => any;`;
}

function generateToolPrompt(tools: Tool[]): string {
  if (tools.length === 0) {
    return "";
  }

  // Generate Harmony-native tool definitions using TypeScript-like syntax
  // According to Harmony docs, tools should be in a namespace (typically "functions")
  const harmonyDefs = tools.map((t) => generateToolHarmonyDefinition(t)).join("\n\n");

  return [
    "",
    "# Tools",
    "## functions",
    "namespace functions {",
    harmonyDefs,
    "} // namespace functions",
    "",
    "Note: Tool calls must go to the commentary channel with format:",
    '<|channel|>commentary to=functions.tool_name <|constrain|>json<|message|>{"param":"value"}<|call|>',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Message conversion: ToolCall / ToolResult → text
// ---------------------------------------------------------------------------

function convertMessagesForTextMode(messages: Message[]): Message[] {
  const converted = messages.flatMap((msg): Message[] => {
    if (msg.role === "assistant") {
      const hasToolCalls = msg.content.some((c) => c.type === "toolCall");
      if (!hasToolCalls) {
        return [msg];
      }
      // Convert tool call blocks to text markers so the model can see the history
      const parts = msg.content
        .map((block) => {
          if (block.type === "text") {
            return block.text;
          }
          if (block.type === "toolCall") {
            const tc = block as ToolCall;
            return `${TOOL_CALL_START}\n${JSON.stringify({ name: tc.name, arguments: tc.arguments })}\n${TOOL_CALL_END}`;
          }
          // Skip thinking blocks — they're internal
          return "";
        })
        .filter(Boolean);
      return [
        {
          ...msg,
          content: [{ type: "text" as const, text: parts.join("\n") }],
        },
      ];
    }

    if (msg.role === "toolResult") {
      const textParts = msg.content.map((c) => (c.type === "text" ? c.text : "[non-text content]"));
      return [
        {
          role: "user" as const,
          content: `[Tool Result for "${msg.toolName}"]:\n${textParts.join("\n")}`,
          timestamp: msg.timestamp,
        },
      ];
    }

    return [msg];
  });

  // Merge consecutive user messages to avoid role-ordering rejections
  return mergeConsecutiveUserMessages(converted);
}

function mergeConsecutiveUserMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    const prev = result[result.length - 1];
    if (msg.role === "user" && prev?.role === "user") {
      const prevText = typeof prev.content === "string" ? prev.content : "";
      const curText = typeof msg.content === "string" ? msg.content : "";
      result[result.length - 1] = {
        role: "user",
        content: `${prevText}\n\n${curText}`,
        timestamp: msg.timestamp,
      };
    } else {
      result.push(msg);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Response parsing: extract tool calls from text
// ---------------------------------------------------------------------------

/**
 * Strip leaked control tokens that gpt-oss sometimes emits (e.g. <|end|>,
 * <|start|>, <|channel|>).  These are internal model delimiters that should
 * never appear in the output.
 *
 * According to Harmony format docs (https://github.com/openai/harmony),
 * these tokens are part of the structured format but Ollama doesn't handle
 * them correctly, so we strip them to prevent parsing errors.
 */
function stripControlTokens(text: string): string {
  // Strip all Harmony control tokens: <|start|>, <|end|>, <|message|>, <|channel|>, etc.
  return text.replace(/<\|[^|]+\|>/g, "");
}

/**
 * Harmony message block structure with full header information
 */
interface HarmonyBlock {
  role?: string;
  channel?: string;
  recipient?: string; // to=functions.tool_name
  contentType?: string; // <|constrain|>json
  content: string;
  stopToken?: string; // <|call|>, <|return|>, or <|end|>
}

/**
 * Parse Harmony format blocks from text.
 * Harmony format: <|start|>role<|channel|>channel_name to=recipient <|constrain|>type<|message|>content<|call|>
 *
 * According to Harmony docs:
 * - Tool calls: <|start|>assistant<|channel|>commentary to=functions.tool_name <|constrain|>json<|message|>{"arg":"value"}<|call|>
 * - Regular messages: <|start|>assistant<|channel|>final<|message|>content<|return|>
 *
 * Returns an array of parsed blocks with role, channel, recipient, content type, and content.
 */
function parseHarmonyBlocks(text: string): HarmonyBlock[] {
  const blocks: HarmonyBlock[] = [];

  // Pattern: <|start|>ROLE<|channel|>CHANNEL to=RECIPIENT <|constrain|>TYPE<|message|>CONTENT<|STOP|>
  // Handle all variations: with/without channel, with/without recipient, with/without constrain
  // Stop tokens: <|call|>, <|return|>, <|end|>
  const blockPattern =
    /<\|start\|>([^<]*?)(?:<\|channel\|>([^<]*?))?(?:\s+to=([^\s<]+))?(?:\s+<\|constrain\|>([^<]+))?(?:<\|message\|>([\s\S]*?))(<\|call\||<\|return\||<\|end\|>)/g;

  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(text)) !== null) {
    const role = match[1]?.trim();
    const channel = match[2]?.trim();
    const recipient = match[3]?.trim();
    const contentType = match[4]?.trim();
    const content = match[5]?.trim() || "";
    const stopToken = match[6]?.trim();

    blocks.push({
      role,
      channel,
      recipient,
      contentType,
      content,
      stopToken,
    });
  }

  return blocks;
}

/**
 * Extract tool calls from Harmony format blocks.
 * According to Harmony docs, tool calls have:
 * - channel: "commentary"
 * - recipient: "to=functions.tool_name" in the header
 * - contentType: "<|constrain|>json"
 * - stopToken: "<|call|>"
 *
 * Returns array of tool calls found in Harmony format.
 */
function extractHarmonyToolCalls(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const blocks = parseHarmonyBlocks(text);
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  for (const block of blocks) {
    // Tool calls in Harmony format have:
    // - recipient (to=functions.tool_name) OR channel=commentary with <|call|> stop token
    // - contentType json (or content that looks like JSON)
    // - stopToken <|call|>
    const isToolCall =
      (block.recipient && block.stopToken === "<|call|>") ||
      (block.channel === "commentary" && block.stopToken === "<|call|>");

    if (isToolCall && block.content) {
      // Extract tool name from recipient (e.g., "functions.get_current_weather" → "get_current_weather")
      let toolName: string | undefined;
      if (block.recipient) {
        toolName = extractToolName(block.recipient);
      }

      // Parse JSON arguments from content
      // Harmony format: <|message|>{"location":"San Francisco"}
      const cleaned = stripControlTokens(block.content);
      try {
        const args = JSON.parse(cleaned) as Record<string, unknown>;
        if (toolName) {
          logDebug(
            `harmony-wrapper: Parsed Harmony-native tool call: "${toolName}" from recipient "${block.recipient}" in channel "${block.channel}"`,
          );
          toolCalls.push({
            name: toolName,
            arguments: args,
          });
        } else {
          // Fallback: try to extract from content if it's a JSON object with "name" field
          if (typeof args === "object" && "name" in args && typeof args.name === "string") {
            toolCalls.push({
              name: extractToolName(args.name as string),
              arguments: args,
            });
          }
        }
      } catch (err) {
        logWarn(
          `harmony-wrapper: Could not parse tool call JSON from Harmony block: ${cleaned.slice(0, 200)} (error: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
  }

  return toolCalls;
}

/**
 * Extract text content from Harmony format blocks (for non-tool-call content).
 * Harmony uses: <|start|>role<|channel|>channel_name<|message|>content<|end|>
 *
 * This function extracts regular message content, excluding tool calls.
 */
function extractHarmonyContent(text: string): string {
  const blocks = parseHarmonyBlocks(text);

  if (blocks.length === 0) {
    // Fallback: try simple pattern extraction if no structured blocks found
    const messagePattern = /<\|message\|>([\s\S]*?)(?:<\|call\||<\|return\||<\|end\|>)/g;
    const matches = Array.from(text.matchAll(messagePattern));
    if (matches.length > 0) {
      return matches.map((m) => m[1]).join("\n");
    }
    // No Harmony structure found, return as-is (might be plain text)
    return text;
  }

  // Filter out tool calls (those with <|call|> stop token)
  const nonToolBlocks = blocks.filter((b) => b.stopToken !== "<|call|>");

  // Prioritize final channel for user-facing content
  const finalBlocks = nonToolBlocks.filter((b) => b.channel === "final");
  if (finalBlocks.length > 0) {
    return finalBlocks.map((b) => b.content).join("\n");
  }

  // Fallback: concatenate all non-tool blocks
  if (nonToolBlocks.length > 0) {
    return nonToolBlocks.map((b) => b.content).join("\n");
  }

  // If all blocks are tool calls, return empty (tool calls are handled separately)
  return "";
}

/**
 * Extract tool name from potentially namespaced name.
 * Harmony supports namespaces like "namespace::tool_name" or "namespace.tool_name"
 */
function extractToolName(name: string): string {
  // Handle namespace::tool_name format
  if (name.includes("::")) {
    const parts = name.split("::");
    const toolName = parts[parts.length - 1]; // Take last part after ::
    if (toolName !== name) {
      logDebug(`harmony-wrapper: Extracted tool name from namespace: "${name}" → "${toolName}"`);
    }
    return toolName;
  }
  // Handle namespace.tool_name format
  if (name.includes(".")) {
    const parts = name.split(".");
    const toolName = parts[parts.length - 1]; // Take last part after .
    if (toolName !== name) {
      logDebug(`harmony-wrapper: Extracted tool name from namespace: "${name}" → "${toolName}"`);
    }
    return toolName;
  }
  return name;
}

/**
 * Parse a single tool call from JSON, handling various formats and normalizations.
 */
function parseSingleToolCall(
  raw: string,
): { name: string; arguments: Record<string, unknown> } | null {
  // Strip any leaked control tokens before parsing JSON
  const cleaned = stripControlTokens(raw);
  if (cleaned !== raw) {
    logDebug(
      `harmony-wrapper: Stripped control tokens from tool call JSON. Before: ${raw.slice(0, 200)}`,
    );
  }

  try {
    const parsed = JSON.parse(cleaned) as { name?: string; arguments?: Record<string, unknown> };
    if (parsed.name && typeof parsed.name === "string") {
      // Extract tool name (handling namespaces)
      const toolName = extractToolName(parsed.name);

      // Unwrap double-wrapped arguments: if `parsed.arguments` itself has
      // a `{name, arguments}` structure, extract the inner `arguments`.
      let args: Record<string, unknown> = parsed.arguments ?? {};
      if (
        typeof args === "object" &&
        "name" in args &&
        "arguments" in args &&
        typeof args.arguments === "object" &&
        args.arguments !== null
      ) {
        args = args.arguments as Record<string, unknown>;
      }

      // Fix array values that should be strings (e.g. command: ["bash","-lc","ls"])
      // by joining them into a single string.
      for (const [key, val] of Object.entries(args)) {
        if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
          args[key] = (val as string[]).join(" ");
        }
      }

      return {
        name: toolName,
        arguments: args,
      };
    }
  } catch (err) {
    logWarn(
      `harmony-wrapper: Could not parse tool call JSON: ${cleaned.slice(0, 200)} (error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }

  return null;
}

function parseToolCallsFromText(
  text: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];

  // Strategy 1: Parse Harmony-native format (PRIORITY - this is the correct format)
  // Format: <|start|>assistant<|channel|>commentary to=functions.tool_name <|constrain|>json<|message|>{"arg":"val"}<|call|>
  const harmonyCalls = extractHarmonyToolCalls(text);
  if (harmonyCalls.length > 0) {
    logDebug(`harmony-wrapper: Found ${harmonyCalls.length} tool call(s) in Harmony-native format`);
    return harmonyCalls;
  }

  // Strategy 2: Parse our custom <tool_call> markers (backward compatibility)
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf(TOOL_CALL_START, pos);
    if (start < 0) {
      break;
    }
    const end = text.indexOf(TOOL_CALL_END, start);
    if (end < 0) {
      break;
    }

    const raw = text.slice(start + TOOL_CALL_START.length, end).trim();
    const toolCall = parseSingleToolCall(raw);
    if (toolCall) {
      calls.push(toolCall);
    }

    pos = end + TOOL_CALL_END.length;
  }

  // Strategy 3: Parse Harmony-native function call format (alternative syntax)
  // Harmony might output function calls in a structured way within message blocks
  // Look for patterns like: functions.get_location() or namespace::function_name({...})
  if (calls.length === 0) {
    // Pattern: function_name({...}) or namespace::function_name({...}) or namespace.function_name({...})
    const functionCallPattern = /(\w+(?:::\w+|\.\w+)?)\s*\(\s*(\{[\s\S]*?\})\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = functionCallPattern.exec(text)) !== null) {
      const functionName = match[1];
      const argsJson = match[2];
      const toolCall = parseSingleToolCall(`{"name": "${functionName}", "arguments": ${argsJson}}`);
      if (toolCall) {
        logDebug(`harmony-wrapper: Parsed Harmony function call format: ${functionName}(...)`);
        calls.push(toolCall);
      }
    }
  }

  // Strategy 4: Detect alternative tool call formats (fallback)
  // e.g. `read>{"path":"USER.md"}` or `toolname>{"key":"val"}`
  if (calls.length === 0) {
    const altPattern = /^(\w+(?:::\w+|\.\w+)?)>\s*(\{[\s\S]*?\})\s*$/gm;
    let altMatch: RegExpExecArray | null;
    while ((altMatch = altPattern.exec(text)) !== null) {
      const toolName = altMatch[1];
      const jsonStr = stripControlTokens(altMatch[2]);
      const toolCall = parseSingleToolCall(`{"name": "${toolName}", "arguments": ${jsonStr}}`);
      if (toolCall) {
        logWarn(`harmony-wrapper: Parsed alternative tool call format: "${toolName}">...`);
        calls.push(toolCall);
      }
    }
  }

  return calls;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

async function pipeAndParseToolCalls(
  input: AssistantMessageEventStream,
  output: AssistantMessageEventStream,
): Promise<void> {
  let fullText = "";

  try {
    for await (const event of input) {
      // Accumulate text for post-hoc tool call detection
      if (event.type === "text_delta") {
        fullText += event.delta;
      }

      // Everything except "done" is passed through unchanged.
      // This means the user sees streaming text (including <tool_call> markers).
      if (event.type !== "done") {
        output.push(event);
        continue;
      }

      // --- Diagnostic: log the full accumulated text from the model ---
      if (fullText.length > 0) {
        logDebug(
          `harmony-wrapper: Full model output (${fullText.length} chars):\n${fullText.slice(0, 1000)}`,
        );
      }

      // --- Detect leaked control tokens (common with gpt-oss) ---
      const controlTokenPattern = /<\|[^|]+\|>/g;
      const controlTokens = fullText.match(controlTokenPattern);
      if (controlTokens && controlTokens.length > 0) {
        logWarn(
          `harmony-wrapper: ⚠ Model output contains ${controlTokens.length} leaked control token(s): ${controlTokens.join(", ")}`,
        );
      }

      // "done" — check accumulated text for tool calls.
      // First, try to extract content from Harmony format if present
      // Harmony format: <|start|>role<|channel|>channel_name<|message|>content<|end|>
      let textToParse = fullText;
      const harmonyContent = extractHarmonyContent(fullText);
      if (harmonyContent !== fullText) {
        logDebug(
          `harmony-wrapper: Extracted Harmony content (${harmonyContent.length} chars) from Harmony format structure`,
        );
        textToParse = harmonyContent;
      }

      const toolCalls = parseToolCallsFromText(textToParse);

      if (toolCalls.length === 0) {
        // No tool calls found → pass through as-is.
        output.push(event);
        continue;
      }

      logDebug(
        `harmony-wrapper: Detected ${toolCalls.length} tool call(s) in text: ${toolCalls.map((tc) => tc.name).join(", ")}`,
      );

      // Build a modified AssistantMessage that contains real ToolCall blocks
      // instead of text with markers.
      const originalMessage = event.message;

      // Separate text before the first marker from the rest.
      // Use the parsed text (which may have Harmony structure stripped)
      const firstMarkerPos = textToParse.indexOf(TOOL_CALL_START);
      const textBefore = firstMarkerPos > 0 ? textToParse.slice(0, firstMarkerPos).trim() : "";

      // Keep non-text content blocks (e.g. thinking) from the original message.
      const nonTextBlocks = originalMessage.content.filter((b) => b.type !== "text");

      const toolCallBlocks: ToolCall[] = toolCalls.map((tc, i) => ({
        type: "toolCall" as const,
        id: `harmony-tc-${Date.now()}-${i}`,
        name: tc.name,
        arguments: tc.arguments as Record<string, never>,
      }));

      const modifiedContent = [
        ...nonTextBlocks,
        ...(textBefore ? [{ type: "text" as const, text: textBefore }] : []),
        ...toolCallBlocks,
      ];

      const modifiedMessage: AssistantMessage = {
        ...originalMessage,
        content: modifiedContent,
        stopReason: "toolUse",
      };

      // Emit synthetic toolcall events so the agent loop picks them up.
      const textBlockCount = modifiedContent.filter(
        (b) => b.type === "text" || b.type === "thinking",
      ).length;
      for (let i = 0; i < toolCallBlocks.length; i++) {
        const idx = textBlockCount + i;
        const tc = toolCallBlocks[i];
        output.push({
          type: "toolcall_start",
          contentIndex: idx,
          partial: modifiedMessage,
        });
        output.push({
          type: "toolcall_delta",
          contentIndex: idx,
          delta: JSON.stringify(tc.arguments),
          partial: modifiedMessage,
        });
        output.push({
          type: "toolcall_end",
          contentIndex: idx,
          toolCall: tc,
          partial: modifiedMessage,
        });
      }

      // Final "done" with toolUse stop reason.
      output.push({
        type: "done",
        reason: "toolUse",
        message: modifiedMessage,
      });
    }
  } catch (err) {
    const errorMessage: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-completions",
      provider: "ollama",
      model: "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
    };
    output.push({ type: "error", reason: "error", error: errorMessage });
  }
}

/**
 * Creates a StreamFn wrapper that bypasses Ollama's broken Harmony parser
 * for gpt-oss models.
 *
 * Returns `null` when the model is not gpt-oss on Ollama (no wrapping needed).
 */
export function createGptOssHarmonyWrapper(params: {
  modelProvider?: string;
  modelId?: string;
}): ((streamFn: StreamFn) => StreamFn) | null {
  if (!isGptOssOnOllama(params)) {
    return null;
  }

  logDebug(
    `harmony-wrapper: Will bypass Ollama Harmony parser for ${params.modelProvider}/${params.modelId}`,
  );

  return (streamFn: StreamFn): StreamFn => {
    const wrapped: StreamFn = (model, context, options) => {
      const tools = context.tools ?? [];

      if (tools.length === 0) {
        // No tools → nothing to bypass, call through directly.
        return streamFn(model, context, options);
      }

      logDebug(
        `harmony-wrapper: Intercepting request — moving ${tools.length} tool(s) from API to system prompt`,
      );

      // 1. Build modified context: no API tools, tool defs in system prompt,
      //    tool history converted to text.
      const modifiedContext: Context = {
        systemPrompt: (context.systemPrompt ?? "") + generateToolPrompt(tools),
        messages: convertMessagesForTextMode(context.messages),
        // Omit tools → Ollama won't activate Harmony tool-call parsing.
      };

      // 2. Call the real streamFn (may return sync or async).
      const streamResult = streamFn(model, modifiedContext, options);

      // 3. Create wrapped output stream.
      const wrappedStream = createAssistantMessageEventStream();

      // Handle both sync (AssistantMessageEventStream) and async (Promise<…>) return.
      const attach = async () => {
        const originalStream = await streamResult;
        await pipeAndParseToolCalls(originalStream, wrappedStream);
      };

      attach().catch((err) => {
        logWarn(`harmony-wrapper: stream processing error: ${err}`);
        const errorMessage: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        wrappedStream.push({ type: "error", reason: "error", error: errorMessage });
      });

      return wrappedStream;
    };

    return wrapped;
  };
}
