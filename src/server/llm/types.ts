/**
 * Shared contract every LLM provider must satisfy.
 *
 * The orchestrator talks to this interface only; provider-specific clients
 * live next to it in `./openrouter.ts` and `./gemini.ts` and are selected by
 * `./index.ts` based on the `LLM_PROVIDER` env var (default: "openrouter").
 *
 * Adding a new provider is a three-step exercise:
 *   1. Drop a file in this directory exporting `generateInvestigatorCompletion`.
 *   2. Wire it into `getLLMClient()` in `./index.ts`.
 *   3. Document the env vars in README.md.
 */

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

/**
 * The contract every provider implementation must satisfy. Keep it small —
 * the orchestrator only needs the raw assistant text plus a few metadata
 * fields for logging / debugging.
 */
export type LLMClient = {
  readonly provider: string;
  generateInvestigatorCompletion(options: GenerateOptions): Promise<GenerateResult>;
};