import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { __testing } from "./smart-compaction-instructions.js";

const {
  analyzeConversationContent,
  generateSmartCompactionInstructions,
  extractTextFromMessage,
  extractToolCallNames,
  detectCorrectionHint,
  extractLastUserIntent,
} = __testing;

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function userMsg(content: string): AgentMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantTextMsg(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic",
    provider: "anthropic",
    model: "claude-3",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantWithToolCalls(toolNames: string[]): AgentMessage {
  return {
    role: "assistant",
    content: toolNames.map((name, idx) => ({
      type: "toolCall" as const,
      id: `tc-${idx}`,
      name,
      arguments: {},
    })),
    api: "anthropic",
    provider: "anthropic",
    model: "claude-3",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResultMsg(toolName: string, text: string, isError = false): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
    toolName,
    isError,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// extractTextFromMessage
// ---------------------------------------------------------------------------

describe("extractTextFromMessage", () => {
  it("extracts from string content (user message)", () => {
    expect(extractTextFromMessage(userMsg("hello world"))).toBe("hello world");
  });

  it("extracts from array content (assistant message)", () => {
    expect(extractTextFromMessage(assistantTextMsg("response text"))).toBe("response text");
  });

  it("returns empty for empty content array", () => {
    const msg: AgentMessage = {
      role: "assistant",
      content: [],
      api: "anthropic",
      provider: "anthropic",
      model: "claude-3",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    expect(extractTextFromMessage(msg)).toBe("");
  });

  it("handles tool call messages (no text content)", () => {
    const msg = assistantWithToolCalls(["read", "write"]);
    expect(extractTextFromMessage(msg)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// extractToolCallNames
// ---------------------------------------------------------------------------

describe("extractToolCallNames", () => {
  it("extracts tool names from assistant message", () => {
    const msg = assistantWithToolCalls(["read", "exec", "write"]);
    expect(extractToolCallNames(msg)).toEqual(["read", "exec", "write"]);
  });

  it("returns empty for user message", () => {
    expect(extractToolCallNames(userMsg("hi"))).toEqual([]);
  });

  it("returns empty for tool result message", () => {
    expect(extractToolCallNames(toolResultMsg("exec", "ok"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeConversationContent
// ---------------------------------------------------------------------------

describe("analyzeConversationContent", () => {
  it("returns empty analysis for empty messages", () => {
    const a = analyzeConversationContent([]);
    expect(a.messageCount).toBe(0);
    expect(a.hasCode).toBe(false);
    expect(a.hasErrors).toBe(false);
  });

  it("detects code blocks", () => {
    const messages: AgentMessage[] = [
      userMsg("Please write:\n```ts\nconst x = 1;\n```"),
      assistantTextMsg("Done"),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.hasCode).toBe(true);
  });

  it("detects function/class keywords as code", () => {
    const a = analyzeConversationContent([
      assistantTextMsg("I created function fetchData() that returns..."),
    ]);
    expect(a.hasCode).toBe(true);
  });

  it("detects errors", () => {
    const messages: AgentMessage[] = [
      userMsg("I got an error when running the build"),
      assistantTextMsg("Let me fix that bug"),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.hasErrors).toBe(true);
  });

  it("detects exec commands via tool calls", () => {
    const messages: AgentMessage[] = [
      assistantWithToolCalls(["exec"]),
      toolResultMsg("exec", "npm build ok"),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.hasExecCommands).toBe(true);
    expect(a.toolUsage.get("exec")).toBe(2); // once from assistant, once from toolResult
  });

  it("detects decisions", () => {
    const a = analyzeConversationContent([
      assistantTextMsg("I decided to opt for the simpler approach"),
    ]);
    expect(a.hasDecisions).toBe(true);
  });

  it("detects questions and counts them (user messages only)", () => {
    const messages: AgentMessage[] = [
      userMsg("What file? Which function?"),
      assistantTextMsg("The file is app.ts. Shall I edit it?"),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.hasQuestions).toBe(true);
    // Only user question marks are counted
    expect(a.questionCount).toBe(2);
  });

  it("detects subagent context", () => {
    const a = analyzeConversationContent([userMsg("The subagent completed the task")]);
    expect(a.isSubagentTask).toBe(true);
  });

  it("extracts file paths", () => {
    const messages: AgentMessage[] = [assistantTextMsg("Modified src/index.ts and config.json")];
    const a = analyzeConversationContent(messages);
    expect(a.filePaths).toContain("src/index.ts");
    expect(a.filePaths).toContain("config.json");
  });

  it("deduplicates file paths", () => {
    const messages: AgentMessage[] = [
      userMsg("Edit src/app.ts"),
      assistantTextMsg("Modified src/app.ts"),
    ];
    const a = analyzeConversationContent(messages);
    const appCount = a.filePaths.filter((p) => p === "src/app.ts").length;
    expect(appCount).toBe(1);
  });

  it("tracks tool usage from both assistant and toolResult", () => {
    const messages: AgentMessage[] = [
      assistantWithToolCalls(["read"]),
      toolResultMsg("read", "file content"),
      assistantWithToolCalls(["read", "write"]),
      toolResultMsg("read", "other file"),
      toolResultMsg("write", "ok"),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.toolUsage.get("read")).toBe(4); // 2 from assistant + 2 from toolResult
    expect(a.toolUsage.get("write")).toBe(2); // 1 from assistant + 1 from toolResult
  });

  it("counts error tool results", () => {
    const messages: AgentMessage[] = [
      toolResultMsg("exec", "ENOENT", true),
      toolResultMsg("exec", "ok", false),
      toolResultMsg("read", "permission denied", true),
    ];
    const a = analyzeConversationContent(messages);
    expect(a.errorToolCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// detectCorrectionHint
// ---------------------------------------------------------------------------

describe("detectCorrectionHint", () => {
  it("detects user correction after assistant", () => {
    const messages: AgentMessage[] = [
      assistantTextMsg("I used approach A"),
      userMsg("No, that's not what I wanted"),
    ];
    expect(detectCorrectionHint(messages)).toBeDefined();
    expect(detectCorrectionHint(messages)).toContain("corrected");
  });

  it("returns undefined when no correction pattern", () => {
    const messages: AgentMessage[] = [
      assistantTextMsg("Here is the result"),
      userMsg("Great, now do the next step"),
    ];
    expect(detectCorrectionHint(messages)).toBeUndefined();
  });

  it("does not trigger on non-user-after-assistant sequences", () => {
    const messages: AgentMessage[] = [userMsg("No, not that"), userMsg("Wrong approach")];
    expect(detectCorrectionHint(messages)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractLastUserIntent
// ---------------------------------------------------------------------------

describe("extractLastUserIntent", () => {
  it("returns last user message snippet", () => {
    const messages: AgentMessage[] = [
      userMsg("First request"),
      assistantTextMsg("Done"),
      userMsg("Now add tests"),
    ];
    expect(extractLastUserIntent(messages)).toBe("Now add tests");
  });

  it("truncates long messages", () => {
    const long = "x".repeat(100);
    const messages: AgentMessage[] = [userMsg(long)];
    const intent = extractLastUserIntent(messages);
    expect(intent).toBeDefined();
    expect(intent!.length).toBeLessThanOrEqual(80);
    expect(intent!.endsWith("...")).toBe(true);
  });

  it("returns undefined for empty array", () => {
    expect(extractLastUserIntent([])).toBeUndefined();
  });

  it("skips non-user messages at the end", () => {
    const messages: AgentMessage[] = [userMsg("Do this"), assistantTextMsg("Done")];
    expect(extractLastUserIntent(messages)).toBe("Do this");
  });
});

// ---------------------------------------------------------------------------
// generateSmartCompactionInstructions
// ---------------------------------------------------------------------------

describe("generateSmartCompactionInstructions", () => {
  it("returns undefined for too-short conversations", () => {
    expect(generateSmartCompactionInstructions([])).toBeUndefined();
    expect(generateSmartCompactionInstructions([userMsg("hi")])).toBeUndefined();
  });

  it("returns minimal output for trivial conversations with no patterns", () => {
    const messages: AgentMessage[] = [userMsg("hello"), assistantTextMsg("hi there")];
    // No code, errors, decisions, exec, questions — only LAST USER REQUEST is emitted
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("LAST USER REQUEST");
    // Should NOT contain any content-specific sections
    expect(result).not.toContain("CODE WORK");
    expect(result).not.toContain("ERROR RESOLUTION");
    expect(result).not.toContain("COMMAND EXECUTION");
    expect(result).not.toContain("DECISION LOG");
  });

  it("includes CODE WORK section when code detected", () => {
    const messages: AgentMessage[] = [
      userMsg("Edit src/utils.ts"),
      assistantTextMsg("```ts\nexport function foo() {}\n```"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("CODE WORK");
    expect(result).toContain("src/utils.ts");
  });

  it("includes ERROR RESOLUTION section when errors detected", () => {
    const messages: AgentMessage[] = [
      userMsg("I got an error"),
      assistantTextMsg("The bug was in the handler"),
      toolResultMsg("exec", "build failed", true),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("ERROR RESOLUTION");
  });

  it("includes COMMAND EXECUTION section when exec tools used", () => {
    const messages: AgentMessage[] = [
      assistantWithToolCalls(["exec"]),
      toolResultMsg("exec", "npm test passed"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("COMMAND EXECUTION");
  });

  it("includes DECISION LOG section when decisions detected", () => {
    const messages: AgentMessage[] = [
      userMsg("Which approach?"),
      assistantTextMsg("I decided to go with approach B"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("DECISION LOG");
  });

  it("includes PENDING QUESTIONS section", () => {
    const messages: AgentMessage[] = [
      userMsg("What is the best approach? How should I test?"),
      assistantTextMsg("Let me think about that"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("PENDING QUESTIONS");
    expect(result).toContain("2 question(s)");
  });

  it("includes LAST USER REQUEST", () => {
    const messages: AgentMessage[] = [
      userMsg("Add authentication to the API"),
      assistantTextMsg("```ts\nfunction auth() {}\n```"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("LAST USER REQUEST");
    expect(result).toContain("Add authentication to the API");
  });

  it("includes USER FEEDBACK when correction detected", () => {
    const messages: AgentMessage[] = [
      assistantTextMsg("I used SQL for storage"),
      userMsg("No, that's not what I wanted — use Redis"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("USER FEEDBACK");
  });

  it("includes CRITICAL suffix on all outputs", () => {
    const messages: AgentMessage[] = [
      userMsg("Fix the error in build.ts"),
      assistantTextMsg("Done, fixed the crash"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    expect(result).toContain("CRITICAL");
    expect(result).toContain("narrative arc");
  });

  it("combines multiple sections for rich conversations", () => {
    const messages: AgentMessage[] = [
      userMsg("Edit src/server.ts to fix the crash"),
      assistantWithToolCalls(["read"]),
      toolResultMsg("read", "export function handleRequest() { throw new Error('oops'); }"),
      assistantTextMsg(
        "I found the bug in the function handler. I decided to use a try-catch.\n```ts\ntry { handleRequest(); } catch(e) {}\n```",
      ),
      assistantWithToolCalls(["exec"]),
      toolResultMsg("exec", "tests passed"),
      userMsg("What about edge cases?"),
    ];
    const result = generateSmartCompactionInstructions(messages);
    expect(result).toBeDefined();
    // Should have multiple focus areas
    expect(result).toContain("CODE WORK"); // code blocks + function keyword
    expect(result).toContain("DECISION LOG"); // "decided"
    expect(result).toContain("PENDING QUESTIONS"); // user question at end
    expect(result).toContain("LAST USER REQUEST");
  });
});
