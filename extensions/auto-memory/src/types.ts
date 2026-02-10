export type AutoMemoryConfig = {
  enabled?: boolean;
  messageThreshold?: number;
  minImportance?: number;
  notificationEnabled?: boolean;
  notificationMessage?: string;
  maxMessagesContext?: number;
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
