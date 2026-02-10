import path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import type { AutoMemoryConfig } from "./src/types.js";
import { resolveAgentWorkspaceDir } from "../../src/agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../src/routing/session-key.js";
import { readMemorySummary } from "./src/memory-reader.js";
import { writeToMemory } from "./src/memory-writer.js";
import { analyzeMessages } from "./src/message-analyzer.js";
import { sendNotification } from "./src/notification.js";

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as AutoMemoryConfig;

  // Check if plugin is enabled
  if (cfg.enabled === false) {
    api.logger.info("auto-memory: plugin disabled");
    return;
  }

  const messageThreshold = cfg.messageThreshold ?? 5;
  const minImportance = cfg.minImportance ?? 0.7;
  const notificationEnabled = cfg.notificationEnabled !== false;
  const notificationMessage = cfg.notificationMessage ?? "💾 Memory updated";
  const maxMessagesContext = cfg.maxMessagesContext ?? 30;

  // Per-session message counter
  const messageCounts = new Map<string, number>();

  api.on("agent_end", async (event, ctx) => {
    try {
      // Skip if not successful or no messages
      if (!event.success || !event.messages || event.messages.length === 0) {
        api.logger.info(
          `auto-memory: skipping (success=${event.success}, messages=${event.messages?.length ?? 0})`,
        );
        return;
      }

      const sessionKey = ctx.sessionKey;
      if (!sessionKey) {
        api.logger.warn("auto-memory: no sessionKey in context");
        return;
      }

      // Increment message count for this session
      const currentCount = (messageCounts.get(sessionKey) ?? 0) + 1;
      messageCounts.set(sessionKey, currentCount);

      // Check if we've reached the threshold
      if (currentCount < messageThreshold) {
        api.logger.info(
          `auto-memory: message ${currentCount}/${messageThreshold} for session (waiting for threshold)`,
        );
        return;
      }

      // Reset counter
      messageCounts.set(sessionKey, 0);

      api.logger.info(`auto-memory: analyzing conversation (session: ${sessionKey})`);

      // Resolve workspace
      const agentId = ctx.agentId ?? resolveAgentIdFromSessionKey(sessionKey);
      const workspaceDir = ctx.workspaceDir ?? resolveAgentWorkspaceDir(api.config, agentId);
      if (!workspaceDir) {
        api.logger.warn("auto-memory: no workspaceDir available");
        return;
      }

      api.logger.info(`auto-memory: workspaceDir=${workspaceDir}, agentId=${agentId}`);

      // Read existing memory summary for context
      const memoryDir = path.join(workspaceDir, "memory");
      const memorySummary = await readMemorySummary(memoryDir);

      // Analyze messages (pass logger for debug visibility)
      const analysis = await analyzeMessages(
        event.messages,
        api.config,
        workspaceDir,
        minImportance,
        api.logger,
        memorySummary,
        maxMessagesContext,
      );

      if (analysis.facts.length === 0) {
        api.logger.info("auto-memory: no important facts found");
        return;
      }

      api.logger.info(`auto-memory: extracted ${analysis.facts.length} facts`);

      // Write to memory
      const writeResult = await writeToMemory(analysis.facts, api.config, sessionKey, ctx.agentId);

      if (!writeResult.success) {
        api.logger.error(`auto-memory: failed to write memory: ${writeResult.error}`);
        return;
      }

      api.logger.info(`auto-memory: memory updated (${writeResult.filePath})`);

      // Send notification if enabled
      if (notificationEnabled) {
        const notifyResult = await sendNotification(
          notificationMessage,
          sessionKey,
          api.config,
          api.runtime,
        );

        if (!notifyResult.success) {
          api.logger.warn(`auto-memory: notification failed: ${notifyResult.error}`);
        }
      }
    } catch (err) {
      api.logger.error(`auto-memory: error: ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        api.logger.warn(`auto-memory: stack: ${err.stack.split("\n").slice(0, 5).join(" | ")}`);
      }
    }
  });
}
