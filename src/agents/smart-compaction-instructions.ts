import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationAnalysis {
  hasCode: boolean;
  hasErrors: boolean;
  hasExecCommands: boolean;
  hasDecisions: boolean;
  hasQuestions: boolean;
  isSubagentTask: boolean;
  filePaths: string[];
  toolNames: string[];
  toolUsage: Map<string, number>;
  questionCount: number;
  messageCount: number;
  errorToolCount: number;
  hasCorrectionPatterns: boolean;
  correctionHint: string | undefined;
  lastUserIntent: string | undefined;
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/** Extract plain text from any AgentMessage, regardless of content shape. */
function extractTextFromMessage(msg: AgentMessage): string {
  if (!msg || typeof msg !== "object") {
    return "";
  }
  const m = msg as Record<string, unknown>;
  const content = m.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      parts.push(b.text);
    }
    if (b.type === "thinking" && typeof b.thinking === "string") {
      parts.push(b.thinking);
    }
  }
  return parts.join("\n");
}

/** Extract tool call names from an assistant message's content array. */
function extractToolCallNames(msg: AgentMessage): string[] {
  if (!msg || typeof msg !== "object") {
    return [];
  }
  const m = msg as Record<string, unknown>;
  if (m.role !== "assistant" || !Array.isArray(m.content)) {
    return [];
  }
  const names: string[] = [];
  for (const block of m.content as Array<Record<string, unknown>>) {
    if (block?.type === "toolCall" && typeof block.name === "string") {
      names.push(block.name);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Keyword sets (lowercase, checked against lowercased text)
// ---------------------------------------------------------------------------

const DECISION_KEYWORDS = [
  "decid",
  "choice",
  "opt for",
  "going with",
  "prefer",
  "chose",
  "trade-off",
  "tradeoff",
];
const ERROR_KEYWORDS = ["error", "fail", "exception", "crash", "bug", "fix", "broken", "issue"];
const EXEC_TOOL_NAMES = new Set(["exec", "execute", "bash", "shell"]);

const FILE_PATH_RE = /[\w\-./]+\.(ts|tsx|jsx|js|json|md|txt|py|sh|yaml|yml|toml|css|html)\b/g;

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

export function analyzeConversationContent(messages: AgentMessage[]): ConversationAnalysis {
  const analysis: ConversationAnalysis = {
    hasCode: false,
    hasErrors: false,
    hasExecCommands: false,
    hasDecisions: false,
    hasQuestions: false,
    isSubagentTask: false,
    filePaths: [],
    toolNames: [],
    toolUsage: new Map(),
    questionCount: 0,
    messageCount: messages.length,
    errorToolCount: 0,
    hasCorrectionPatterns: false,
    correctionHint: undefined,
    lastUserIntent: undefined,
  };

  if (!messages || messages.length === 0) {
    return analysis;
  }

  const filePathSet = new Set<string>();
  const toolNameSet = new Set<string>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      continue;
    }

    const text = extractTextFromMessage(msg);
    const lower = text.toLowerCase();
    const role = (msg as Record<string, unknown>).role;

    // Code detection: fenced blocks, function/class keywords
    if (lower.includes("```") || lower.includes("function ") || lower.includes("class ")) {
      analysis.hasCode = true;
    }

    // Error detection
    if (ERROR_KEYWORDS.some((kw) => lower.includes(kw))) {
      analysis.hasErrors = true;
    }

    // Decision detection
    if (DECISION_KEYWORDS.some((kw) => lower.includes(kw))) {
      analysis.hasDecisions = true;
    }

    // Question detection (user messages only)
    if (role === "user" && text.includes("?")) {
      analysis.hasQuestions = true;
      analysis.questionCount += (text.match(/\?/g) || []).length;
    }

    // Subagent detection
    if (lower.includes("subagent") || lower.includes("sub-agent") || lower.includes("sub_agent")) {
      analysis.isSubagentTask = true;
    }

    // File path extraction
    const filePaths = text.match(FILE_PATH_RE);
    if (filePaths) {
      for (const fp of filePaths) {
        filePathSet.add(fp);
      }
    }

    // Tool call tracking (from assistant content blocks)
    const toolCalls = extractToolCallNames(msg);
    for (const name of toolCalls) {
      toolNameSet.add(name);
      analysis.toolUsage.set(name, (analysis.toolUsage.get(name) || 0) + 1);
      if (EXEC_TOOL_NAMES.has(name)) {
        analysis.hasExecCommands = true;
      }
    }

    // Error tool results
    if (role === "toolResult") {
      const tr = msg as Record<string, unknown>;
      if (tr.isError === true) {
        analysis.errorToolCount++;
      }
      const toolName = typeof tr.toolName === "string" ? tr.toolName : undefined;
      if (toolName) {
        toolNameSet.add(toolName);
        analysis.toolUsage.set(toolName, (analysis.toolUsage.get(toolName) || 0) + 1);
        if (EXEC_TOOL_NAMES.has(toolName)) {
          analysis.hasExecCommands = true;
        }
      }
    }
  }

  analysis.filePaths = [...filePathSet];
  analysis.toolNames = [...toolNameSet];

  // Detect correction patterns and extract last user intent
  analysis.correctionHint = detectCorrectionHint(messages);
  analysis.hasCorrectionPatterns = analysis.correctionHint !== undefined;
  analysis.lastUserIntent = extractLastUserIntent(messages);

  return analysis;
}

// ---------------------------------------------------------------------------
// Proactive helpers
// ---------------------------------------------------------------------------

/** Scan for user-corrects-assistant patterns (user says "no"/"not what I"/"wrong" after assistant). */
function detectCorrectionHint(messages: AgentMessage[]): string | undefined {
  const correctionRe = /\b(no[,.]?\s|not what|wrong|that's not|incorrect|instead\b)/i;
  for (let i = 1; i < messages.length; i++) {
    const cur = messages[i] as Record<string, unknown>;
    const prev = messages[i - 1] as Record<string, unknown>;
    if (cur.role !== "user" || prev.role !== "assistant") {
      continue;
    }
    const text = extractTextFromMessage(messages[i]);
    if (correctionRe.test(text)) {
      return "User corrected the approach — preserve the correction and preferred alternative";
    }
  }
  return undefined;
}

/** Extract a brief intent description from the last user message. */
function extractLastUserIntent(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m.role !== "user") {
      continue;
    }
    const text = extractTextFromMessage(messages[i]).trim();
    if (!text) {
      continue;
    }
    // Return a truncated snippet of the last user request
    const snippet = text.length > 80 ? `${text.slice(0, 77)}...` : text;
    return snippet;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Instruction generation
// ---------------------------------------------------------------------------

/**
 * Generate context-aware "Additional focus" instructions for compaction.
 * These are appended by `generateSummary()` to the built-in SUMMARIZATION_PROMPT.
 * Returns `undefined` when the conversation is too short to benefit from extra hints.
 */
export function generateSmartCompactionInstructions(messages: AgentMessage[]): string | undefined {
  if (!messages || messages.length < 2) {
    return undefined;
  }

  const analysis = analyzeConversationContent(messages);
  const sections: string[] = [];

  // --- Content-specific focus areas ---

  if (analysis.hasCode) {
    let codeLine =
      "CODE WORK: Preserve implementation details, API contracts, and refactoring decisions.";
    if (analysis.filePaths.length > 0) {
      const shown = analysis.filePaths.slice(0, 15).join(", ");
      const extra =
        analysis.filePaths.length > 15 ? ` (+${analysis.filePaths.length - 15} more)` : "";
      codeLine += ` Key files: ${shown}${extra}.`;
    }
    sections.push(codeLine);
  }

  if (analysis.hasErrors || analysis.errorToolCount > 0) {
    sections.push(
      `ERROR RESOLUTION: Document root causes found, fixes applied, and prevention strategies.` +
        (analysis.errorToolCount > 0
          ? ` ${analysis.errorToolCount} tool error(s) encountered.`
          : ""),
    );
  }

  if (analysis.hasExecCommands) {
    sections.push(
      "COMMAND EXECUTION: Remember environment setup steps, build processes, and any failed attempts with workarounds.",
    );
  }

  if (analysis.hasDecisions) {
    sections.push(
      "DECISION LOG: Prioritize WHY choices were made (trade-offs, rejected alternatives), not just WHAT.",
    );
  }

  if (analysis.hasQuestions && analysis.questionCount > 0) {
    sections.push(
      `PENDING QUESTIONS: ${analysis.questionCount} question(s) detected — preserve context needed to answer them.`,
    );
  }

  if (analysis.isSubagentTask) {
    sections.push(
      "SUBAGENT CONTEXT: This is (or was) a delegated subtask. Preserve the original objective, results delivered, and continuation point.",
    );
  }

  // --- Proactive preservation ---

  if (analysis.hasCorrectionPatterns && analysis.correctionHint) {
    sections.push(`USER FEEDBACK: ${analysis.correctionHint}.`);
  }

  if (analysis.lastUserIntent) {
    sections.push(
      `LAST USER REQUEST: "${analysis.lastUserIntent}" — ensure continuity from this point.`,
    );
  }

  // Tool-usage hints: detect possibly incomplete write operations
  const writeCount = analysis.toolUsage.get("write") ?? 0;
  const editCount = analysis.toolUsage.get("edit") ?? 0;
  if ((writeCount > 0 || editCount > 0) && !analysis.toolUsage.has("read")) {
    sections.push(
      "POSSIBLE INCOMPLETE FILE OPS: File writes/edits occurred without subsequent reads — may need verification.",
    );
  }

  // Nothing interesting found; let the default prompt handle it
  if (sections.length === 0) {
    return undefined;
  }

  // Assemble the final "Additional focus" block
  return (
    sections.map((s) => `- ${s}`).join("\n") +
    "\n\n" +
    "CRITICAL: Do NOT truncate mid-thought or mid-decision. " +
    "Preserve the narrative arc of the current task, references to external resources, " +
    "and failed approaches (to avoid repeating them)."
  );
}

export const __testing = {
  analyzeConversationContent,
  generateSmartCompactionInstructions,
  extractTextFromMessage,
  extractToolCallNames,
  detectCorrectionHint,
  extractLastUserIntent,
} as const;
