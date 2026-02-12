import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";
import fsSync from "node:fs";
import os from "node:os";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { importNodeLlamaCpp } from "../../../src/memory/node-llama.js";
import { resolveUserPath } from "../../../src/utils.js";

const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

function sanitizeAndNormalizeEmbedding(vec: number[]): number[] {
  const sanitized = vec.map((value) => (Number.isFinite(value) ? value : 0));
  const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
  if (magnitude < 1e-10) {
    return sanitized;
  }
  return sanitized.map((value) => value / magnitude);
}

export class LocalEmbeddingProvider {
  private llama: Llama | null = null;
  private embeddingModel: LlamaModel | null = null;
  private embeddingContext: LlamaEmbeddingContext | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly modelPath: string;
  private readonly modelCacheDir?: string;

  constructor(modelPath?: string, modelCacheDir?: string) {
    this.modelPath = modelPath?.trim() || DEFAULT_LOCAL_MODEL;
    this.modelCacheDir = modelCacheDir?.trim();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.embeddingContext) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

    if (!this.llama) {
      // Note: node-llama-cpp uses all available CPU threads by default for embedding
      // The threading is handled internally by the llama.cpp library
      this.llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }

    if (!this.embeddingModel) {
      const resolved = await resolveModelFile(this.modelPath, this.modelCacheDir);
      this.embeddingModel = await this.llama.loadModel({ modelPath: resolved });
    }

    if (!this.embeddingContext) {
      // Note: llama.cpp automatically uses all available CPU cores for inference
      // The threading is optimized internally by the library
      this.embeddingContext = await this.embeddingModel.createEmbeddingContext();
    }
  }

  async embed(text: string): Promise<number[]> {
    await this.ensureInitialized();
    if (!this.embeddingContext) {
      throw new Error("Embedding context not initialized");
    }
    const embedding = await this.embeddingContext.getEmbeddingFor(text);
    return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    await this.ensureInitialized();
    if (!this.embeddingContext) {
      throw new Error("Embedding context not initialized");
    }
    const embeddings = await Promise.all(
      texts.map(async (text) => {
        const embedding = await this.embeddingContext!.getEmbeddingFor(text);
        return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
      }),
    );
    return embeddings;
  }

  getVectorDimensions(): number {
    // embeddinggemma-300M produces 768-dimensional vectors
    // This is a common dimension for smaller embedding models
    return 768;
  }
}
