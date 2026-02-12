import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import type { ExtractedFact } from "./types.js";

const TABLE_NAME = "auto_memory";

type MemoryEntry = {
  id: string;
  text: string;
  vector: number[];
  importance: number;
  category: string;
  createdAt: number;
};

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;

async function loadLanceDB(): Promise<typeof import("@lancedb/lancedb")> {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(`auto-memory: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
}

export class LanceDBStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private vectorDim: number;

  constructor(
    private readonly dbPath: string,
    vectorDim: number,
  ) {
    this.vectorDim = vectorDim;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.dbPath);
    const tables = await this.db.tableNames();

    if (tables.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    } else {
      // Create table with schema
      this.table = await this.db.createTable(
        TABLE_NAME,
        [
          {
            id: "__schema__",
            text: "",
            vector: Array.from({ length: this.vectorDim }).fill(0),
            importance: 0,
            category: "other",
            createdAt: 0,
          },
        ],
        { mode: "overwrite" },
      );
      // Remove schema row
      await this.table.delete('id = "__schema__"');
    }
  }

  async store(fact: ExtractedFact, vector: number[]): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (vector.length !== this.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.vectorDim}, got ${vector.length}`,
      );
    }

    const entry: MemoryEntry = {
      id: randomUUID(),
      text: fact.fact,
      vector,
      importance: fact.importance,
      category: fact.category || "fact",
      createdAt: Date.now(),
    };

    await this.table!.add([entry]);
    return entry;
  }

  async search(
    vector: number[],
    limit = 5,
    minScore = 0.3,
  ): Promise<Array<{ entry: MemoryEntry; score: number }>> {
    await this.ensureInitialized();

    if (vector.length !== this.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.vectorDim}, got ${vector.length}`,
      );
    }

    const results = await this.table!.vectorSearch(vector).limit(limit).toArray();

    // LanceDB uses L2 distance by default; convert to similarity score
    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      // Use inverse for a 0-1 range: sim = 1 / (1 + d)
      const score = 1 / (1 + distance);
      return {
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          importance: row.importance as number,
          category: row.category as string,
          createdAt: row.createdAt as number,
        },
        score,
      };
    });

    return mapped.filter((r) => r.score >= minScore);
  }

  async count(): Promise<number> {
    await this.ensureInitialized();
    return this.table!.countRows();
  }

  async close(): Promise<void> {
    // LanceDB doesn't require explicit close, but we can clean up references
    this.table = null;
    this.db = null;
    this.initPromise = null;
  }
}
