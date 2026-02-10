/**
 * Tool argument normalizer — stream wrapper.
 *
 * Some models (especially gpt-oss) generate malformed tool call arguments:
 *   - Double-wrapped: { name: "exec", arguments: { command: "..." } }
 *     instead of just { command: "..." }
 *   - Wrong property names: cmd instead of command, file_path instead of path
 *   - Array values for string params: cmd: ["bash", "-lc", "ls"]
 *
 * The validation in pi-agent-core's agent-loop.js happens BEFORE our
 * tool execute() function can normalize the params.  This wrapper
 * intercepts the stream events and normalizes tool call arguments in the
 * AssistantMessage *before* the agent loop sees them, preventing
 * validation errors entirely.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { logDebug, logWarn } from "../logger.js";
import { normalizeToolParams, normalizeToolParamsFromSchema } from "./pi-tools.read.js";

// ---------------------------------------------------------------------------
// Argument normalizer for a single toolCall content block
// ---------------------------------------------------------------------------

function normalizeToolCallArgs(
  args: unknown,
  toolName?: string,
  tools?: Array<{ name: string; parameters?: unknown }>,
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;

  // 1. Unwrap double-wrapped arguments:
  //    { name: "exec", arguments: { command: "..." } } → { command: "..." }
  if (
    "name" in record &&
    typeof record.name === "string" &&
    "arguments" in record &&
    typeof record.arguments === "object" &&
    record.arguments !== null
  ) {
    const inner = record.arguments as Record<string, unknown>;
    const innerToolName = record.name;
    logDebug(`[tool-normalizer] Unwrapped double-wrapped arguments for tool "${innerToolName}"`);
    // Apply schema-based normalization if tool is found
    const tool = tools?.find((t) => t.name === innerToolName);
    if (tool && tool.parameters) {
      const normalized = normalizeToolParamsFromSchema(
        inner,
        tool.parameters,
        tool as AnyAgentTool,
      );
      if (normalized) {
        return normalized;
      }
    }
    // Fallback to hardcoded normalization
    return normalizeToolParams(inner) ?? inner;
  }

  // 2. Schema-based normalization (if tool is available)
  if (toolName && tools) {
    const tool = tools.find((t) => t.name === toolName);
    if (tool && tool.parameters) {
      const normalized = normalizeToolParamsFromSchema(
        record,
        tool.parameters,
        tool as AnyAgentTool,
      );
      if (normalized) {
        return normalized;
      }
    }
  }

  // 2.5. Special handling for cron tool: id → action, mode → action (when invalid)
  // gpt-oss sometimes passes id: "add" or mode: "add" instead of action: "add"
  // Also handles cases where id/mode contain an action (e.g., "add-job" contains "add")
  if (toolName === "cron" && !("action" in record)) {
    const validActions = ["status", "list", "add", "update", "remove", "run", "runs", "wake"];
    const validWakeModes = ["now", "next-heartbeat"];
    const validRunModes = ["due", "force"];
    const normalized = { ...record };
    let changed = false;

    // Helper: extract action from a string if it contains a valid action
    const extractAction = (value: string): string | null => {
      // First check exact match
      if (validActions.includes(value)) {
        return value;
      }
      // Then check if it starts with a valid action (e.g., "add-job" → "add")
      for (const action of validActions) {
        if (value.startsWith(action + "-") || value.startsWith(action + "_")) {
          return action;
        }
      }
      // Also check if it contains a valid action as a word boundary (e.g., "test-add-job" → "add")
      // This is less common but can happen with gpt-oss
      for (const action of validActions) {
        const pattern = new RegExp(`(^|[_-])${action}([_-]|$)`);
        if (pattern.test(value)) {
          return action;
        }
      }
      return null;
    };

    // Priority 1: Check mode first (mode: "add" is more likely to be action than id: "add-job")
    if ("mode" in normalized && !("action" in normalized)) {
      const modeValue = normalized.mode;
      if (typeof modeValue === "string") {
        // If mode is a valid action but not a valid mode value, it's likely meant to be action
        if (
          validActions.includes(modeValue) &&
          !validWakeModes.includes(modeValue) &&
          !validRunModes.includes(modeValue)
        ) {
          normalized.action = modeValue;
          delete normalized.mode;
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized cron tool: mode: "${modeValue}" → action: "${modeValue}"`,
          );
        } else {
          // Try to extract action from mode value (e.g., "add-job" → "add")
          const extracted = extractAction(modeValue);
          if (extracted) {
            normalized.action = extracted;
            delete normalized.mode;
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized cron tool: mode: "${modeValue}" → action: "${extracted}"`,
            );
          }
        }
      }
    }

    // Priority 2: Check id if action still not set
    if ("id" in normalized && !("action" in normalized)) {
      const idValue = normalized.id;
      if (typeof idValue === "string") {
        // Actions that require jobId: update, remove, run, runs
        const actionsRequiringJobId = ["update", "remove", "run", "runs"];

        // If id is exactly a valid action, use it
        if (validActions.includes(idValue)) {
          normalized.action = idValue;
          // If this action requires jobId, we can't use id as jobId since it's the action name
          // Remove id - the error will be thrown later when jobId is missing (which is correct)
          delete normalized.id;
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized cron tool: id: "${idValue}" → action: "${idValue}"`,
          );
        } else {
          // Try to extract action from id value (e.g., "add-job" → "add")
          const extracted = extractAction(idValue);
          if (extracted) {
            normalized.action = extracted;
            // If extracted action requires jobId, we remove id since it can't be used as jobId
            // The error will be thrown later when jobId is missing (which is correct)
            delete normalized.id;
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized cron tool: id: "${idValue}" → action: "${extracted}"`,
            );
          }
        }
      }
    }

    if (changed) {
      return normalized;
    }
  }

  // 2.6. Special handling for gateway tool: raw/mode/type → action (when invalid)
  // gpt-oss sometimes passes raw: "start", mode: "restart", or type: "restart" instead of action: "restart"
  if (toolName === "gateway" && !("action" in record)) {
    const validActions = new Set([
      "restart",
      "config.get",
      "config.schema",
      "config.apply",
      "config.patch",
      "update.run",
    ]);
    const normalized = { ...record };
    let changed = false;

    // Helper: check if a value is a valid action (or can be mapped to one)
    const normalizeActionValue = (value: string): string | null => {
      // Direct match
      if (validActions.has(value)) {
        return value;
      }
      // Map common misnamings
      if (value === "start") {
        return "restart"; // "start" → "restart"
      }
      if (value === "get" || value === "get_config") {
        return "config.get";
      }
      if (value === "schema" || value === "get_schema") {
        return "config.schema";
      }
      if (value === "apply" || value === "apply_config") {
        return "config.apply";
      }
      if (value === "patch" || value === "patch_config") {
        return "config.patch";
      }
      if (value === "update" || value === "run_update") {
        return "update.run";
      }
      return null;
    };

    // Priority 1: Check raw (gpt-oss sometimes uses raw: "start" instead of action: "restart")
    // Note: raw is a valid parameter for config.apply/config.patch, but if it contains an action-like value
    // and action is missing, it's likely meant to be the action
    if ("raw" in normalized && !("action" in normalized)) {
      const rawValue = normalized.raw;
      if (typeof rawValue === "string") {
        const normalizedAction = normalizeActionValue(rawValue.trim());
        if (normalizedAction) {
          normalized.action = normalizedAction;
          // Don't delete raw immediately - it might be needed for config.apply/config.patch
          // But we'll set action which is required
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized gateway tool: raw: "${rawValue}" → action: "${normalizedAction}"`,
          );
        }
      }
    }

    // Priority 2: Check mode (gpt-oss sometimes uses mode: "restart" instead of action: "restart")
    if (!("action" in normalized) && "mode" in normalized) {
      const modeValue = normalized.mode;
      if (typeof modeValue === "string") {
        const normalizedAction = normalizeActionValue(modeValue.trim());
        if (normalizedAction) {
          normalized.action = normalizedAction;
          delete normalized.mode;
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized gateway tool: mode: "${modeValue}" → action: "${normalizedAction}"`,
          );
        }
      }
    }

    // Priority 3: Check type (gpt-oss sometimes uses type: "restart" instead of action: "restart")
    if (!("action" in normalized) && "type" in normalized) {
      const typeValue = normalized.type;
      if (typeof typeValue === "string") {
        const normalizedAction = normalizeActionValue(typeValue.trim());
        if (normalizedAction) {
          normalized.action = normalizedAction;
          delete normalized.type;
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized gateway tool: type: "${typeValue}" → action: "${normalizedAction}"`,
          );
        }
      }
    }

    if (changed) {
      return normalized;
    }
  }

  // 2.7. Special handling for browser tool: mode/ref/type → action (when invalid)
  // gpt-oss sometimes passes mode: "status", ref: "open", or type: "open" instead of action: "open"
  if (toolName === "browser") {
    const validActions = new Set([
      "status",
      "start",
      "stop",
      "profiles",
      "tabs",
      "open",
      "focus",
      "close",
      "snapshot",
      "screenshot",
      "navigate",
      "console",
      "pdf",
      "upload",
      "dialog",
      "act",
    ]);
    const validSnapshotModes = ["efficient"];
    const validImageTypes = new Set(["png", "jpeg"]);
    const normalized = { ...record };
    let changed = false;

    // Helper: check if a value is a valid action
    const isValidAction = (value: string): boolean => {
      return validActions.has(value);
    };

    // Helper: check if a string looks like a URL
    const looksLikeUrl = (value: string): boolean => {
      return /^https?:\/\//i.test(value.trim());
    };

    // Clean up null/undefined values
    if ("target" in normalized && (normalized.target === null || normalized.target === undefined)) {
      delete normalized.target;
      changed = true;
      logDebug(`[tool-normalizer] Removed null target from browser tool`);
    }

    // Priority 1: Normalize inputRef → targetUrl (always, if inputRef looks like a URL)
    // This should happen before action normalization since inputRef might contain a URL
    if ("inputRef" in normalized) {
      const inputRefValue = normalized.inputRef;
      if (typeof inputRefValue === "string" && inputRefValue.trim()) {
        const trimmed = inputRefValue.trim();
        // If inputRef looks like a URL, always map it to targetUrl (even if targetUrl exists)
        if (looksLikeUrl(trimmed)) {
          normalized.targetUrl = trimmed;
          // Keep inputRef if it's not a URL (might be an element reference)
          // But prioritize targetUrl for URLs
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized browser tool: inputRef (URL): "${trimmed}" → targetUrl: "${trimmed}"`,
          );
        } else if (!("targetUrl" in normalized)) {
          // If inputRef doesn't look like a URL but targetUrl is missing, still try to use it
          normalized.targetUrl = trimmed;
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized browser tool: inputRef: "${trimmed}" → targetUrl: "${trimmed}"`,
          );
        }
      }
    }

    // Priority 2: Normalize action from ref/type/mode (only if action is missing)
    if (!("action" in normalized)) {
      // Check ref (gpt-oss often uses ref: "open" instead of action: "open")
      if ("ref" in normalized) {
        const refValue = normalized.ref;
        if (typeof refValue === "string" && isValidAction(refValue)) {
          normalized.action = refValue;
          // Don't delete ref - it might be used for other purposes (element reference)
          // But if ref is the action, we should preserve it as action
          changed = true;
          logDebug(
            `[tool-normalizer] Normalized browser tool: ref: "${refValue}" → action: "${refValue}"`,
          );
        }
      }

      // Check request.kind (gpt-oss sometimes uses request: { kind: "open" } instead of action: "open")
      // Note: request.kind is for browser actions (click, type, etc.), but gpt-oss confuses it with tool action
      if ("request" in normalized) {
        const requestValue = normalized.request;
        if (requestValue && typeof requestValue === "object" && "kind" in requestValue) {
          const requestKind = requestValue.kind;
          if (typeof requestKind === "string" && isValidAction(requestKind)) {
            normalized.action = requestKind;
            // Don't delete request - it might contain other valid fields
            // But remove kind from request since it's now the action
            const request = requestValue as Record<string, unknown>;
            if (Object.keys(request).length === 1 && "kind" in request) {
              // If request only has kind, we can delete the whole request object
              delete normalized.request;
            } else {
              // Otherwise, just remove kind from request
              delete request.kind;
            }
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized browser tool: request.kind: "${requestKind}" → action: "${requestKind}"`,
            );
          }
        }
      }

      // Check type (gpt-oss sometimes uses type: "open" instead of action: "open")
      // or type: "https://..." instead of targetUrl
      if ("type" in normalized) {
        const typeValue = normalized.type;
        if (typeof typeValue === "string") {
          if (isValidAction(typeValue)) {
            normalized.action = typeValue;
            delete normalized.type;
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized browser tool: type: "${typeValue}" → action: "${typeValue}"`,
            );
          } else if (looksLikeUrl(typeValue)) {
            // If type contains a URL, map it to targetUrl and remove type
            if (!("targetUrl" in normalized)) {
              normalized.targetUrl = typeValue.trim();
            }
            delete normalized.type;
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized browser tool: type (URL): "${typeValue}" → targetUrl: "${typeValue}"`,
            );
          } else if (!validImageTypes.has(typeValue)) {
            // If type is not a valid action, not a URL, and not a valid image type, remove it
            delete normalized.type;
            changed = true;
            logDebug(`[tool-normalizer] Removed invalid type from browser tool: "${typeValue}"`);
          }
        }
      }

      // Check mode if action is still missing
      if ("mode" in normalized) {
        const modeValue = normalized.mode;
        if (typeof modeValue === "string") {
          // If mode is a valid action but not a valid snapshot mode, it's likely meant to be action
          if (validActions.has(modeValue) && !validSnapshotModes.includes(modeValue)) {
            normalized.action = modeValue;
            delete normalized.mode;
            changed = true;
            logDebug(
              `[tool-normalizer] Normalized browser tool: mode: "${modeValue}" → action: "${modeValue}"`,
            );
          }
        }
      }
    }

    // Clean up: if type is still present but not a valid image type, remove it
    if ("type" in normalized && typeof normalized.type === "string") {
      if (!validImageTypes.has(normalized.type) && !isValidAction(normalized.type)) {
        delete normalized.type;
        changed = true;
        logDebug(`[tool-normalizer] Removed invalid type from browser tool: "${normalized.type}"`);
      }
    }

    if (changed) {
      return normalized;
    }
  }

  // 3. Fallback to hardcoded normalizations (cmd→command, file_path→path, etc.)
  return normalizeToolParams(record) ?? undefined;
}

// ---------------------------------------------------------------------------
// Normalize tool calls inside an AssistantMessage
// ---------------------------------------------------------------------------

function normalizeMessageToolCalls(
  message: AssistantMessage,
  tools?: Array<{ name: string; parameters?: unknown }>,
): AssistantMessage {
  if (!message.content || !Array.isArray(message.content)) {
    return message;
  }

  let modified = false;
  const normalizedContent = message.content.map((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "toolCall") {
      return block;
    }

    const toolCall = block as { type: "toolCall"; id: string; name: string; arguments: unknown };

    // --- Diagnostic logging: log EVERY tool call as received ---
    const argsJson = JSON.stringify(toolCall.arguments);
    const argsKeys =
      toolCall.arguments && typeof toolCall.arguments === "object"
        ? Object.keys(toolCall.arguments as Record<string, unknown>)
        : [];

    if (argsKeys.length === 0) {
      logWarn(
        `[tool-normalizer] ⚠ Tool "${toolCall.name}" called with EMPTY arguments: ${argsJson}`,
      );
    } else {
      logDebug(
        `[tool-normalizer] Tool "${toolCall.name}" raw args (keys: ${argsKeys.join(", ")}): ${argsJson.slice(0, 300)}`,
      );
    }

    const normalized = normalizeToolCallArgs(toolCall.arguments, toolCall.name, tools);
    if (!normalized) {
      return block;
    }

    // Check if normalization actually changed anything
    const originalJson = JSON.stringify(toolCall.arguments);
    const normalizedJson = JSON.stringify(normalized);
    if (originalJson === normalizedJson) {
      return block;
    }

    modified = true;
    logWarn(
      `[tool-normalizer] Normalized args for "${toolCall.name}": ${originalJson.slice(0, 300)} → ${normalizedJson.slice(0, 300)}`,
    );
    return {
      ...toolCall,
      arguments: normalized,
    };
  });

  if (!modified) {
    return message;
  }

  return {
    ...message,
    content: normalizedContent,
  } as AssistantMessage;
}

// ---------------------------------------------------------------------------
// Stream wrapper
// ---------------------------------------------------------------------------

async function pipeAndNormalize(
  input: ReturnType<typeof createAssistantMessageEventStream>,
  output: ReturnType<typeof createAssistantMessageEventStream>,
  tools?: Array<{ name: string; parameters?: unknown }>,
): Promise<void> {
  let fullText = "";

  try {
    for await (const event of input) {
      // Accumulate text for diagnostic logging
      if (event.type === "text_delta" && typeof event.delta === "string") {
        fullText += event.delta;
      }

      // Normalize tool call arguments in the final message
      if (event.type === "done") {
        // --- Diagnostic: detect leaked control tokens in non-harmony streams ---
        if (fullText.length > 0) {
          const controlTokenPattern = /<\|[^|]+\|>/g;
          const controlTokens = fullText.match(controlTokenPattern);
          if (controlTokens && controlTokens.length > 0) {
            logWarn(
              `[tool-normalizer] ⚠ Model output contains ${controlTokens.length} leaked control token(s): ${controlTokens.join(", ")}`,
            );
            logWarn(
              `[tool-normalizer] ⚠ Raw model text (first 500 chars): ${fullText.slice(0, 500)}`,
            );
          }
        }

        // --- Diagnostic: log all tool calls in the final message ---
        const toolCallBlocks = event.message.content?.filter(
          (b: { type: string }) => b?.type === "toolCall",
        );
        if (toolCallBlocks && toolCallBlocks.length > 0) {
          for (const tc of toolCallBlocks) {
            const tcObj = tc as { name: string; arguments: unknown };
            logDebug(
              `[tool-normalizer] Final message tool call: "${tcObj.name}" args=${JSON.stringify(tcObj.arguments).slice(0, 300)}`,
            );
          }
        }

        const normalizedMessage = normalizeMessageToolCalls(event.message, tools);
        output.push({
          ...event,
          message: normalizedMessage,
        });
        continue;
      }

      // Normalize tool call arguments in toolcall_end events (partial message)
      if (event.type === "toolcall_end" && event.partial) {
        const normalizedPartial = normalizeMessageToolCalls(event.partial, tools);
        // Also normalize the individual toolCall
        const normalizedToolCall = event.toolCall
          ? (() => {
              const tc = event.toolCall as {
                type: "toolCall";
                id: string;
                name: string;
                arguments: unknown;
              };
              const normalized = normalizeToolCallArgs(tc.arguments, tc.name, tools);
              if (normalized && JSON.stringify(normalized) !== JSON.stringify(tc.arguments)) {
                return { ...tc, arguments: normalized };
              }
              return event.toolCall;
            })()
          : event.toolCall;

        output.push({
          ...event,
          toolCall: normalizedToolCall,
          partial: normalizedPartial,
        } as AssistantMessageEvent);
        continue;
      }

      // Pass through everything else unchanged
      output.push(event);
    }
  } catch (err) {
    // Re-throw; the outer code handles stream errors.
    throw err;
  }
  output.end();
}

// ---------------------------------------------------------------------------
// Public: wraps a StreamFn to normalize tool arguments
// ---------------------------------------------------------------------------

/**
 * Wraps a StreamFn to automatically normalize tool call arguments in the
 * assistant message events before they reach the agent loop's validation.
 *
 * Uses schema-based normalization when tool schemas are available in the context,
 * falling back to hardcoded normalization for backward compatibility.
 */
export function createToolArgsNormalizerWrapper(streamFn: StreamFn): StreamFn {
  return async (model, context, options) => {
    const originalStream = await streamFn(model, context, options);
    const wrappedStream = createAssistantMessageEventStream();

    // Extract tools from context for schema-based normalization
    const tools = context.tools?.map((tool) => ({
      name: tool.name,
      parameters: tool.parameters,
    }));

    // Pipe events asynchronously, normalizing as we go
    pipeAndNormalize(originalStream, wrappedStream, tools).catch((err) => {
      // If the stream errors, close the wrapped stream
      logDebug(
        `[tool-normalizer] Stream error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return wrappedStream;
  };
}
