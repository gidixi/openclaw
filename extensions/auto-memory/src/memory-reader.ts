import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySummary } from "./types.js";

/**
 * Reads existing memory files and extracts a summary of previous decisions,
 * preferences, and other important notes.
 */
export async function readMemorySummary(
  memoryDir: string,
  maxDays: number = 7,
): Promise<MemorySummary> {
  const summary: MemorySummary = {
    previousDecisions: [],
    previousPreferences: [],
    otherNotes: [],
  };

  try {
    const files = await fs.readdir(memoryDir);
    const memoryFiles = files
      .filter((f) => f.endsWith(".md") && /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .reverse()
      .slice(0, maxDays);

    for (const file of memoryFiles) {
      const filePath = path.join(memoryDir, file);
      try {
        const content = await fs.readFile(filePath, "utf-8");
        const lines = content.split("\n");

        let currentCategory: string | null = null;
        for (const line of lines) {
          // Detect category headers
          if (line.startsWith("### Decisions")) {
            currentCategory = "decision";
            continue;
          } else if (line.startsWith("### Preferences")) {
            currentCategory = "preference";
            continue;
          } else if (line.startsWith("### Facts") || line.startsWith("### Personal Information")) {
            currentCategory = "other";
            continue;
          } else if (line.startsWith("##") || line.startsWith("#")) {
            // New section or date header, reset category
            currentCategory = null;
            continue;
          }

          // Extract bullet points
          if (line.trim().startsWith("-") && currentCategory) {
            const fact = line.trim().substring(1).trim();
            if (fact) {
              if (currentCategory === "decision") {
                summary.previousDecisions?.push(fact);
              } else if (currentCategory === "preference") {
                summary.previousPreferences?.push(fact);
              } else {
                summary.otherNotes?.push(fact);
              }
            }
          }
        }
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    // Limit the number of items per category to avoid overwhelming the context
    const maxItems = 10;
    if (summary.previousDecisions && summary.previousDecisions.length > maxItems) {
      summary.previousDecisions = summary.previousDecisions.slice(-maxItems);
    }
    if (summary.previousPreferences && summary.previousPreferences.length > maxItems) {
      summary.previousPreferences = summary.previousPreferences.slice(-maxItems);
    }
    if (summary.otherNotes && summary.otherNotes.length > maxItems) {
      summary.otherNotes = summary.otherNotes.slice(-maxItems);
    }
  } catch {
    // If memory directory doesn't exist or can't be read, return empty summary
    return summary;
  }

  return summary;
}
