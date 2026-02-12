import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { LanceDBStore } from "./lancedb-store.js";
import type { LocalEmbeddingProvider } from "./local-embedding.js";
import type { ExtractedFact } from "./types.js";
import { resolveAgentWorkspaceDir } from "../../../src/agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../src/routing/session-key.js";

export async function writeToMemory(
  facts: ExtractedFact[],
  config: OpenClawConfig,
  sessionKey: string | undefined,
  agentId: string | undefined,
  lancedbStore?: LanceDBStore,
  embeddingProvider?: LocalEmbeddingProvider,
): Promise<{ success: boolean; filePath?: string; error?: string; storedInLanceDB?: number }> {
  if (facts.length === 0) {
    return { success: true };
  }

  try {
    const resolvedAgentId = agentId ?? resolveAgentIdFromSessionKey(sessionKey);
    const workspaceDir = resolveAgentWorkspaceDir(config, resolvedAgentId);
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Get today's date for filename
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
    const memoryFilePath = path.join(memoryDir, `${dateStr}.md`);

    // Read existing content once (if file exists)
    let existingContent = "";
    let fileExists = false;
    let hasHeader = false;
    try {
      existingContent = await fs.readFile(memoryFilePath, "utf-8");
      fileExists = true;
      // Check if file starts with the date header (normalize whitespace)
      const trimmed = existingContent.trim();
      hasHeader = trimmed.startsWith(`# ${dateStr}`) || trimmed.startsWith(`#${dateStr}`);
    } catch {
      // File doesn't exist, will create new
      fileExists = false;
    }

    // Format new entry
    const timeStr = now.toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const entryLines: string[] = [`## ${timeStr}`];

    // Group facts by category
    const byCategory = new Map<string, ExtractedFact[]>();
    for (const fact of facts) {
      const category = fact.category || "fact";
      if (!byCategory.has(category)) {
        byCategory.set(category, []);
      }
      byCategory.get(category)!.push(fact);
    }

    // Write facts grouped by category
    for (const [category, categoryFacts] of byCategory.entries()) {
      const categoryLabel =
        category === "decision"
          ? "Decisions"
          : category === "preference"
            ? "Preferences"
            : category === "personal_info"
              ? "Personal Information"
              : "Facts";
      entryLines.push(`\n### ${categoryLabel}`);
      for (const fact of categoryFacts) {
        entryLines.push(`- ${fact.fact}`);
      }
    }

    const newEntry = entryLines.join("\n");

    // Prepare final content
    let finalContent = "";

    if (!fileExists) {
      // New file - write header + new entry
      finalContent = `# ${dateStr}\n\n${newEntry}\n`;
    } else if (!hasHeader) {
      // File exists but no header - prepend header to existing content, then add new entry
      const trimmedExisting = existingContent.trim();
      finalContent = `# ${dateStr}\n\n${trimmedExisting}\n\n${newEntry}\n`;
    } else {
      // File exists with header - append new entry preserving existing content
      const trimmedExisting = existingContent.trimEnd();
      // Ensure there's a blank line before the new entry if the file doesn't end with one
      const separator =
        trimmedExisting.endsWith("\n\n") || trimmedExisting.endsWith("\n") ? "" : "\n";
      finalContent = `${trimmedExisting}${separator}\n${newEntry}\n`;
    }

    // Write final content atomically (single write operation)
    await fs.writeFile(memoryFilePath, finalContent, "utf-8");

    // Store in LanceDB if enabled
    let storedInLanceDB = 0;
    if (lancedbStore && embeddingProvider && facts.length > 0) {
      try {
        for (const fact of facts) {
          try {
            const vector = await embeddingProvider.embed(fact.fact);
            await lancedbStore.store(fact, vector);
            storedInLanceDB++;
          } catch (err) {
            // Log but don't fail - file write already succeeded
            console.warn(
              `auto-memory: failed to store fact in LanceDB: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        // Log but don't fail - file write already succeeded
        console.warn(
          `auto-memory: LanceDB storage error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return { success: true, filePath: memoryFilePath, storedInLanceDB };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error };
  }
}
