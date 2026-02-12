import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../src/config/config.js";
import type { MemorySearchManager } from "../../src/memory/types.js";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import type { PluginLogger } from "../../src/plugins/types.js";
import type { AutoMemoryConfig } from "./src/types.js";
import type { ExtractedFact } from "./src/types.js";
import { resolveAgentWorkspaceDir } from "../../src/agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../src/routing/session-key.js";
import { LanceDBMemoryManager } from "./src/lancedb-memory-manager.js";
import { LanceDBStore } from "./src/lancedb-store.js";
import { LocalEmbeddingProvider } from "./src/local-embedding.js";
import { analyzeMessages } from "./src/message-analyzer.js";
import { sendNotification } from "./src/notification.js";

// Global registry for auto-memory manager factory
// This allows getMemorySearchManager to access the manager without direct imports
(globalThis as any).__openclawAutoMemoryFactory = (
  cfg: OpenClawConfig,
  agentId: string,
  autoMemoryConfig: AutoMemoryConfig,
): MemorySearchManager | null => {
  try {
    return new LanceDBMemoryManager(cfg, agentId, autoMemoryConfig);
  } catch (err) {
    console.warn("auto-memory: failed to create manager:", err);
    return null;
  }
};

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

  // LanceDB and embedding provider are REQUIRED - plugin only works with embeddings
  let lancedbStore: LanceDBStore;
  let embeddingProvider: LocalEmbeddingProvider;

  try {
    // Initialize embedding provider (required)
    embeddingProvider = new LocalEmbeddingProvider(
      cfg.embedding?.modelPath,
      cfg.embedding?.modelCacheDir,
    );
    const vectorDim = embeddingProvider.getVectorDimensions();

    // Initialize LanceDB store (required)
    const dbPath =
      cfg.lancedb?.dbPath ?? path.join(homedir(), ".openclaw", "memory", "auto-memory-lancedb");
    lancedbStore = new LanceDBStore(dbPath, vectorDim);

    api.logger.info(
      `auto-memory: initialized with LanceDB and local embeddings (db: ${dbPath}, model: ${cfg.embedding?.modelPath || "default"})`,
    );

    // Pre-initialize embedding provider to trigger model download if needed
    // This ensures the model is downloaded at startup rather than on first use
    api.logger.info(
      "auto-memory: pre-initializing embedding model (this may download the model if needed)...",
    );
    // Use void to fire-and-forget the async operation
    void (async () => {
      try {
        await embeddingProvider.embed("test"); // This will trigger model download if needed
        api.logger.info("auto-memory: embedding model ready");
      } catch (err) {
        api.logger.warn(
          `auto-memory: pre-initialization failed (model will be downloaded on first use): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Don't fail the plugin - it will retry on first actual use
      }
    })();
  } catch (err) {
    api.logger.error(
      `auto-memory: failed to initialize LanceDB/embeddings: ${err instanceof Error ? err.message : String(err)}. Plugin requires embeddings to function.`,
    );
    return; // Disable plugin if embeddings can't be initialized
  }

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

      // Note: We don't read file-based memory summary anymore since we only use LanceDB
      // The memory summary is now retrieved from LanceDB when needed
      const memorySummary = undefined;

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

      // Store in LanceDB only (no file writing)
      const storedCount = await storeInLanceDB(
        analysis.facts,
        lancedbStore,
        embeddingProvider,
        api.logger,
      );

      if (storedCount === 0) {
        api.logger.warn("auto-memory: failed to store any facts in LanceDB");
        return;
      }

      api.logger.info(`auto-memory: stored ${storedCount} facts in LanceDB`);

      // Send notification if enabled
      if (notificationEnabled) {
        // Create a more informative notification message
        const factsText = storedCount === 1 ? "1 fatto" : `${storedCount} fatti`;
        const customMessage = `${notificationMessage} (${factsText} salvati)`;

        const notifyResult = await sendNotification(
          customMessage,
          sessionKey,
          api.config,
          api.runtime,
          event.messages, // Pass messages to help extract channel info
        );

        if (!notifyResult.success) {
          api.logger.warn(`auto-memory: notification failed: ${notifyResult.error}`);
          // Log sessionKey for debugging
          api.logger.debug(`auto-memory: sessionKey was: ${sessionKey}`);
        } else {
          api.logger.info(`auto-memory: notification sent successfully to channel`);
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

/**
 * Store facts in LanceDB with embeddings (no file writing)
 */
async function storeInLanceDB(
  facts: ExtractedFact[],
  lancedbStore: LanceDBStore,
  embeddingProvider: LocalEmbeddingProvider,
  logger?: PluginLogger,
): Promise<number> {
  if (facts.length === 0) {
    return 0;
  }

  let storedCount = 0;
  for (const fact of facts) {
    try {
      // Generate embedding for the fact
      const vector = await embeddingProvider.embed(fact.fact);

      // Store in LanceDB
      await lancedbStore.store(fact, vector);
      storedCount++;
    } catch (err) {
      logger?.warn(
        `auto-memory: failed to store fact in LanceDB: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return storedCount;
}
