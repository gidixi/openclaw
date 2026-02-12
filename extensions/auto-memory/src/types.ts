export type AutoMemoryConfig = {
  enabled?: boolean;
  messageThreshold?: number;
  minImportance?: number;
  notificationEnabled?: boolean;
  notificationMessage?: string;
  maxMessagesContext?: number;
  // LanceDB configuration (required - plugin only works with embeddings)
  lancedb?: {
    dbPath?: string;
  };
  // Local embedding configuration (required - plugin only works with embeddings)
  embedding?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

export type ExtractedFact = {
  fact: string;
  category: string;
  importance: number;
};

export type AnalysisResult = {
  facts: ExtractedFact[];
  summary?: string;
};

export type MemorySummary = {
  previousDecisions?: string[];
  previousPreferences?: string[];
  otherNotes?: string[];
};
