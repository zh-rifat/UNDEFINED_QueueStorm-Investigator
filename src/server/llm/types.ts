export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type GenerateOptions = {
  system: string;
  user: string;
  /** Optional per-call model override — primarily for tests / future swaps. */
  model?: string;
};

export type GenerateResult = {
  rawText: string;
  model: string;
  finishReason: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  };
};

export type LLMClient = {
  readonly provider: string;
  generateInvestigatorCompletion(options: GenerateOptions): Promise<GenerateResult>;
};