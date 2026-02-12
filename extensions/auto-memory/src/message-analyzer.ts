import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import type { AnalysisResult, ExtractedFact, MemorySummary } from "./types.js";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  // Source checkout (tests/dev)
  try {
    const mod = await import("../../../src/agents/pi-embedded-runner.js");
    // oxlint-disable-next-line typescript/no-explicit-any
    if (typeof (mod as any).runEmbeddedPiAgent === "function") {
      // oxlint-disable-next-line typescript/no-explicit-any
      return (mod as any).runEmbeddedPiAgent;
    }
  } catch {
    // ignore – not running from source
  }

  // Bundled install (built)
  const mod = await import("../../../agents/pi-embedded-runner.js");
  if (typeof mod.runEmbeddedPiAgent !== "function") {
    throw new Error("Internal error: runEmbeddedPiAgent not available");
  }
  return mod.runEmbeddedPiAgent;
}

/** Resolve provider/model from the user's config (same approach as llm-task). */
function resolveModelFromConfig(config?: OpenClawConfig): {
  provider: string | undefined;
  model: string | undefined;
} {
  const primary =
    typeof config?.agents?.defaults?.model?.primary === "string"
      ? config.agents.defaults.model.primary
      : undefined;

  if (!primary) {
    return { provider: undefined, model: undefined };
  }

  const slashIdx = primary.indexOf("/");
  if (slashIdx < 0) {
    return { provider: primary, model: undefined };
  }

  return {
    provider: primary.substring(0, slashIdx),
    model: primary.substring(slashIdx + 1),
  };
}

function extractTextFromMessage(msg: unknown): string {
  if (!msg || typeof msg !== "object") {
    return "";
  }
  const msgObj = msg as Record<string, unknown>;
  const role = msgObj.role;
  if (role !== "user" && role !== "assistant") {
    return "";
  }

  const content = msgObj.content;

  // Handle string content directly
  if (typeof content === "string") {
    return content;
  }

  // Handle array content (content blocks)
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        (block as Record<string, unknown>).type === "text" &&
        "text" in block &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    return texts.join("\n");
  }

  return "";
}

/**
 * Collects conversation text only from recent messages and user/assistant turns.
 * `maxMessages` limits the number of recent messages included in the context.
 */
function collectConversationText(messages: unknown[], maxMessages: number = 30): string {
  const recentMessages = messages.slice(-maxMessages);
  const texts: string[] = [];
  for (const msg of recentMessages) {
    const text = extractTextFromMessage(msg);
    // Filter out commands and empty text
    if (text && !text.startsWith("/")) {
      texts.push(text);
    }
  }
  return texts.join("\n\n");
}

/**
 * Removes any code fences (e.g., ```json ... ```) from the text.
 */
function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

/**
 * Extracts JSON from text that may contain markdown, emojis, or other formatting.
 * Tries multiple strategies to find valid JSON.
 */
function extractJSON(text: string): string | null {
  // Strategy 0: Try the whole text after stripping code fences first
  const stripped = stripCodeFences(text.trim());
  if (stripped) {
    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === "object") {
        return stripped;
      }
    } catch {
      // Not valid JSON, continue
    }
  }

  // Strategy 1: Find the first { and try to match balanced braces
  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) {
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;
    let endPos = firstBrace;

    for (let i = firstBrace; i < text.length; i++) {
      const char = text[i];

      if (escapeNext) {
        escapeNext = false;
        continue;
      }

      if (char === "\\") {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }

      if (!inString) {
        if (char === "{") {
          braceCount++;
        } else if (char === "}") {
          braceCount--;
          if (braceCount === 0) {
            endPos = i + 1;
            break;
          }
        }
      }
    }

    if (braceCount === 0 && endPos > firstBrace) {
      const candidate = text.substring(firstBrace, endPos);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") {
          return candidate;
        }
      } catch {
        // Not valid JSON, continue
      }
    }
  }

  // Strategy 2: Try to find JSON after common prefixes
  const afterPrefixMatch = text.match(
    /(?:json|response|result|output|data|answer)[\s:]*([{\[][\s\S]*?[}\]])/is,
  );
  if (afterPrefixMatch && afterPrefixMatch[1]) {
    try {
      const parsed = JSON.parse(afterPrefixMatch[1]);
      if (parsed && typeof parsed === "object") {
        return afterPrefixMatch[1];
      }
    } catch {
      // Not valid JSON
    }
  }

  // Strategy 3: Try to find any JSON-like structure (non-greedy)
  const jsonLikeMatch = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/);
  if (jsonLikeMatch) {
    try {
      const parsed = JSON.parse(jsonLikeMatch[0]);
      if (parsed && typeof parsed === "object") {
        return jsonLikeMatch[0];
      }
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Extracts only non-error text payloads.
 */
function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

/**
 * Formats a memory summary for inclusion in the prompt.
 */
function formatMemorySummary(summary?: MemorySummary): string {
  if (!summary) return "No previous information known.";

  const lines: string[] = [];
  if (summary.previousDecisions?.length) {
    lines.push("Previous decisions:");
    lines.push(...summary.previousDecisions.map((d) => `- ${d}`));
  }
  if (summary.previousPreferences?.length) {
    lines.push("Known preferences:");
    lines.push(...summary.previousPreferences.map((p) => `- ${p}`));
  }
  if (summary.otherNotes?.length) {
    lines.push("Other important points:");
    lines.push(...summary.otherNotes.map((n) => `- ${n}`));
  }

  return lines.length > 0 ? lines.join("\n") : "No previous information known.";
}

/**
 * Analyzes a conversation and extracts only the important facts, decisions, and preferences.
 *
 * @param messages - Conversation history (raw messages)
 * @param config - OpenClaw configuration (to extract provider/model)
 * @param workspaceDir - Workspace directory for temporary files
 * @param minImportance - Minimum importance threshold (0-1) for facts
 * @param logger - Optional logger for the plugin
 * @param memorySummary - Optional summary of decisions/preferences already known
 * @param maxMessagesContext - Maximum number of recent messages to include in the prompt
 */
export async function analyzeMessages(
  messages: unknown[],
  config: OpenClawConfig,
  workspaceDir: string,
  minImportance: number,
  logger?: PluginLogger,
  memorySummary?: MemorySummary,
  maxMessagesContext: number = 30,
): Promise<AnalysisResult> {
  const conversationText = collectConversationText(messages, maxMessagesContext);
  if (!conversationText.trim()) {
    logger?.info("auto-memory: no conversation text to analyze");
    return { facts: [] };
  }

  logger?.info(
    `auto-memory: analyzing ${conversationText.length} chars of conversation ` +
      `(${maxMessagesContext} recent messages)`,
  );

  // Resolve provider/model from user config (same pattern as llm-task)
  const { provider, model } = resolveModelFromConfig(config);
  if (!provider || !model) {
    logger?.error(
      `auto-memory: cannot resolve provider/model from config ` +
        `(primary=${config?.agents?.defaults?.model?.primary ?? "unset"})`,
    );
    return { facts: [] };
  }

  logger?.info(`auto-memory: using model ${provider}/${model}`);

  const summaryText = formatMemorySummary(memorySummary);

  const prompt = `You are a JSON API. Your ONLY job is to return valid JSON. Do NOT write any explanatory text.

Analyze this conversation and extract important facts, decisions, or preferences.

Information known so far:
${summaryText}

Recent conversation:
${conversationText}

TASK: Return ONLY a JSON object with this exact structure:
{
  "facts": [
    {
      "fact": "description of the fact",
      "category": "decision|preference|fact|personal_info",
      "importance": 0.0-1.0
    }
  ]
}

RULES:
- Return ONLY the JSON object, nothing else
- If no important facts found, return: {"facts": []}
- importance must be >= ${minImportance} for facts to be saved
- Do NOT add any text, comments, or explanations
- Do NOT use markdown code fences
- Start with { and end with }

EXAMPLE (copy this format exactly):
{"facts": [{"fact": "User prefers email notifications", "category": "preference", "importance": 0.8}]}`;

  const systemPrompt = [
    "You are a JSON-only API. You MUST respond with ONLY valid JSON.",
    "Your response must start with { and end with }.",
    "Do NOT include any text, explanations, emojis, or markdown.",
    "Do NOT wrap JSON in code fences or quotes.",
    'If there are no facts, return: {"facts": []}',
  ].join(" ");

  const fullPrompt = `${systemPrompt}\n\n${prompt}\n\nRemember: Return ONLY JSON, starting with { and ending with }.`;

  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-auto-memory-"));
    const sessionId = `auto-memory-${Date.now()}`;
    const sessionFile = path.join(tmpDir, "session.json");

    logger?.info("auto-memory: loading embedded agent runner");
    const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

    logger?.info("auto-memory: calling LLM for analysis");
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir,
      config,
      prompt: fullPrompt,
      timeoutMs: 30_000,
      runId: `auto-memory-${Date.now()}`,
      provider,
      model,
      disableTools: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const text = collectText((result as any).payloads);
    if (!text) {
      logger?.warn("auto-memory: LLM returned empty output");
      return { facts: [] };
    }

    logger?.info(`auto-memory: got ${text.length} chars from LLM`);

    // Parse JSON response - try multiple extraction strategies
    let parsed: { facts?: ExtractedFact[] };
    const extractedJSON = extractJSON(text);

    if (!extractedJSON) {
      // If no JSON found, the LLM didn't follow instructions
      // Log the response for debugging and return empty facts
      logger?.warn("auto-memory: LLM did not return JSON format");
      logger?.warn(`auto-memory: raw LLM response (first 500 chars): ${text.substring(0, 500)}`);

      // Try one more time: check if the response is very short and might be a simple "no facts" response
      const lowerText = text.toLowerCase().trim();
      if (
        lowerText.length < 200 &&
        (lowerText.includes("no facts") ||
          lowerText.includes("nessun fatto") ||
          lowerText.includes("nessuna informazione") ||
          lowerText.includes("non ci sono") ||
          lowerText === '{"facts": []}' ||
          lowerText === '{"facts": []}')
      ) {
        logger?.info("auto-memory: detected 'no facts' response, returning empty array");
        return { facts: [] };
      }

      // If response seems to contain actual information but not in JSON format,
      // we could try to extract it, but for now we'll just return empty
      // This prevents storing incorrectly formatted data
      logger?.warn("auto-memory: LLM response contains text but no valid JSON - ignoring");
      return { facts: [] };
    }

    // Log extracted JSON for debugging (using info since debug might not be available)
    if (logger && typeof logger.debug === "function") {
      logger.debug(
        `auto-memory: extracted JSON (first 500 chars): ${extractedJSON.substring(0, 500)}`,
      );
    }

    try {
      parsed = JSON.parse(extractedJSON);
    } catch (err) {
      logger?.error(
        `auto-memory: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      logger?.warn(
        `auto-memory: extracted JSON (first 500 chars): ${extractedJSON.substring(0, 500)}`,
      );
      logger?.warn(`auto-memory: raw LLM response (first 500 chars): ${text.substring(0, 500)}`);
      return { facts: [] };
    }

    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    logger?.info(`auto-memory: found ${facts.length} facts before filtering`);

    const filteredFacts = facts.filter(
      (f) =>
        f &&
        typeof f.fact === "string" &&
        typeof f.category === "string" &&
        typeof f.importance === "number" &&
        f.importance >= minImportance,
    );

    logger?.info(
      `auto-memory: ${filteredFacts.length} facts passed importance threshold (>= ${minImportance})`,
    );

    return { facts: filteredFacts };
  } catch (err) {
    logger?.error(
      `auto-memory: analysis error: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (err instanceof Error && err.stack) {
      logger?.warn(`auto-memory: stack: ${err.stack.split("\n").slice(0, 5).join(" | ")}`);
    }
    return { facts: [] };
  } finally {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
