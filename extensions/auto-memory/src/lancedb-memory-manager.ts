import { homedir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
} from "../../../src/memory/types.js";
import type { AutoMemoryConfig } from "./types.js";
import { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { LanceDBStore } from "./lancedb-store.js";
import { LocalEmbeddingProvider } from "./local-embedding.js";

const log = createSubsystemLogger("auto-memory-manager");

/**
 * MemorySearchManager that combines results from LanceDB (auto-memory) with
 * the builtin file-based memory. This allows memory_search to automatically
 * search both sources.
 */
export class LanceDBMemoryManager implements MemorySearchManager {
  private lancedbStore: LanceDBStore | null = null;
  private embeddingProvider: LocalEmbeddingProvider | null = null;
  private baseManager: MemorySearchManager | null = null;
  private baseManagerError: string | null = null;
  private initialized = false;

  constructor(
    private readonly cfg: OpenClawConfig,
    private readonly agentId: string,
    private readonly autoMemoryConfig: AutoMemoryConfig,
  ) {
    log.info("LanceDBMemoryManager created");
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    log.info("LanceDBMemoryManager initializing...");

    // Initialize embedding provider for search queries
    try {
      this.embeddingProvider = new LocalEmbeddingProvider(
        this.autoMemoryConfig.embedding?.modelPath,
        this.autoMemoryConfig.embedding?.modelCacheDir,
      );
      const vectorDim = this.embeddingProvider.getVectorDimensions();
      log.info(`Embedding provider ready (dim=${vectorDim})`);

      // Initialize LanceDB store
      const dbPath =
        this.autoMemoryConfig.lancedb?.dbPath ??
        path.join(homedir(), ".openclaw", "memory", "auto-memory-lancedb");
      this.lancedbStore = new LanceDBStore(dbPath, vectorDim);
      log.info(`LanceDB store initialized at ${dbPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Failed to initialize LanceDB/embeddings: ${msg}`);
    }

    // Load base manager (file-based memory) — failures are non-fatal
    try {
      const { MemoryIndexManager } = await import("../../../src/memory/manager.js");
      this.baseManager = await MemoryIndexManager.get({
        cfg: this.cfg,
        agentId: this.agentId,
      });
      log.info("Base memory manager loaded successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.baseManagerError = msg;
      log.warn(`Base memory manager unavailable (non-fatal): ${msg}`);
    }
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    const maxResults = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.3;

    log.info(`search: query="${query}", maxResults=${maxResults}, minScore=${minScore}`);

    // Collect results from available sources
    const promises: Array<Promise<MemorySearchResult[]>> = [];

    // 1) LanceDB search (primary)
    promises.push(this.searchLanceDB(query, maxResults, minScore));

    // 2) Base file-based search (secondary, only if available)
    if (this.baseManager) {
      promises.push(
        this.baseManager
          .search(query, {
            maxResults,
            minScore,
            sessionKey: opts?.sessionKey,
          })
          .catch((err) => {
            log.warn(
              `Base manager search failed: ${err instanceof Error ? err.message : String(err)}`,
            );
            return [] as MemorySearchResult[];
          }),
      );
    }

    const results = await Promise.all(promises);
    const combined = results.flat();

    log.info(
      `search: LanceDB returned ${results[0]?.length ?? 0}, base returned ${results[1]?.length ?? 0}`,
    );

    // Sort by score (highest first) and limit
    combined.sort((a, b) => b.score - a.score);
    return combined.slice(0, maxResults);
  }

  private async searchLanceDB(
    query: string,
    maxResults: number,
    minScore: number,
  ): Promise<MemorySearchResult[]> {
    if (!this.lancedbStore || !this.embeddingProvider) {
      log.warn(
        `searchLanceDB: not available (store=${!!this.lancedbStore}, embed=${!!this.embeddingProvider})`,
      );
      return [];
    }

    try {
      const queryVector = await this.embeddingProvider.embed(query);
      log.info(`searchLanceDB: embedded query (vector dim=${queryVector.length})`);

      const results = await this.lancedbStore.search(queryVector, maxResults, minScore);
      log.info(`searchLanceDB: found ${results.length} results`);

      return results.map((r) => ({
        path: "auto-memory",
        startLine: 0,
        endLine: 0,
        score: r.score,
        snippet: `[auto-memory] ${r.entry.text}`,
        source: "memory" as const,
        citation: `auto-memory (${r.entry.category}, importance: ${r.entry.importance.toFixed(2)})`,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`searchLanceDB failed: ${msg}`);
      return [];
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    await this.ensureInitialized();

    if (params.relPath === "auto-memory") {
      if (!this.lancedbStore) {
        return { text: "Auto-memory database not available.", path: "auto-memory" };
      }
      try {
        const count = await this.lancedbStore.count();
        return {
          text: `Auto-memory database contains ${count} stored facts extracted from conversations.`,
          path: "auto-memory",
        };
      } catch {
        return { text: "Auto-memory database error.", path: "auto-memory" };
      }
    }

    if (this.baseManager) {
      return await this.baseManager.readFile(params);
    }

    return { text: "", path: params.relPath };
  }

  status(): MemoryProviderStatus {
    const baseStatus = this.baseManager?.status();
    return {
      backend: "builtin",
      provider: "local",
      model: "embeddinggemma-300M",
      files: baseStatus?.files,
      chunks: baseStatus?.chunks,
      workspaceDir: baseStatus?.workspaceDir,
      sources: ["memory"],
      vector: {
        enabled: true,
        available: this.lancedbStore !== null && this.embeddingProvider !== null,
        dims: this.embeddingProvider?.getVectorDimensions(),
      },
      custom: {
        lancedb: {
          enabled: this.lancedbStore !== null,
          dbPath:
            this.autoMemoryConfig.lancedb?.dbPath ??
            path.join(homedir(), ".openclaw", "memory", "auto-memory-lancedb"),
        },
        autoMemory: { enabled: true },
        baseManager: {
          available: this.baseManager !== null,
          error: this.baseManagerError,
        },
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: { completed: number; total: number; label?: string }) => void;
  }) {
    await this.ensureInitialized();
    await this.baseManager?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    await this.ensureInitialized();
    if (this.embeddingProvider) {
      return { ok: true };
    }
    return { ok: false, error: "Embedding provider not initialized" };
  }

  async probeVectorAvailability(): Promise<boolean> {
    await this.ensureInitialized();
    return this.embeddingProvider !== null && this.lancedbStore !== null;
  }

  async close(): Promise<void> {
    await this.baseManager?.close?.();
    await this.lancedbStore?.close?.();
  }
}
