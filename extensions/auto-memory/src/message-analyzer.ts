import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { PluginLogger } from "../../../src/plugins/types.js";
import type { AnalysisResult, ExtractedFact } from "./types.js";

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

function collectConversationText(messages: unknown[]): string {
  const texts: string[] = [];
  for (const msg of messages) {
    const text = extractTextFromMessage(msg);
    if (text && !text.startsWith("/")) {
      texts.push(text);
    }
  }
  return texts.join("\n\n");
}

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  const texts = (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

export async function analyzeMessages(
  messages: unknown[],
  config: OpenClawConfig,
  workspaceDir: string,
  minImportance: number,
  logger?: PluginLogger,
): Promise<AnalysisResult> {
  const conversationText = collectConversationText(messages);
  if (!conversationText.trim()) {
    logger?.info("auto-memory: no conversation text to analyze");
    return { facts: [] };
  }

  logger?.info(`auto-memory: analyzing ${conversationText.length} chars of conversation`);

  // Resolve model from user config (same pattern as llm-task)
  const { provider, model } = resolveModelFromConfig(config);
  if (!provider || !model) {
    logger?.error(
      `auto-memory: cannot resolve provider/model from config ` +
        `(primary=${config?.agents?.defaults?.model?.primary ?? "unset"})`,
    );
    return { facts: [] };
  }

  logger?.info(`auto-memory: using model ${provider}/${model}`);

  const prompt = `Analyze this conversation and extract only the important facts, decisions, or preferences that should be remembered.

Respond in JSON format with an array of objects, each with:
- fact: string describing the fact/decision/preference
- category: one of the following: "decision", "preference", "fact", "personal_info"
- importance: number between 0 and 1 indicating importance (only facts with importance >= ${minImportance} will be saved)

Example response:
{
  "facts": [
    {
      "fact": "User prefers to receive notifications via email",
      "category": "preference",
      "importance": 0.8
    },
    {
      "fact": "Decided to use PostgreSQL for the new project",
      "category": "decision",
      "importance": 0.9
    }
  ]
}

If there are no important facts, respond with: {"facts": []}

Conversation:
${conversationText}`;

  const systemPrompt = [
    "You are an assistant that analyzes conversations to extract important information to remember.",
    "Return ONLY a valid JSON value.",
    "Do not wrap in markdown fences.",
    "Do not include commentary.",
  ].join(" ");

  const fullPrompt = `${systemPrompt}\n\n${prompt}`;

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

    // Parse JSON response
    const raw = stripCodeFences(text);
    let parsed: { facts?: ExtractedFact[] };
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      logger?.error(
        `auto-memory: failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      logger?.warn(`auto-memory: raw LLM response: ${raw.substring(0, 500)}`);
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
