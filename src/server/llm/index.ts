import "server-only";

/**
 * Provider selector for the QueueStorm Investigator.
 *
 * The orchestrator never imports a provider directly — it calls
 * `getLLMClient().generateInvestigatorCompletion(...)`. To switch providers
 * at runtime:
 *
 *   - Set `LLM_PROVIDER=openrouter` (default) or `LLM_PROVIDER=gemini`.
 *   - Or, from code, call `setLLMProvider("gemini")` early in your test
 *     bootstrap. This is the hook used by the sample-case runner when you
 *     want to pin a specific provider without touching `.env`.
 *
 * Each provider validates its own API key lazily on first use, so importing
 * this module does not require every provider's credentials to be present.
 */

import { openrouterClient } from "./openrouter";
import { geminiClient } from "./gemini";
import type { LLMClient } from "./types";

export type ProviderName = "openrouter" | "gemini";

const PROVIDERS: Record<ProviderName, LLMClient> = {
  openrouter: openrouterClient,
  gemini: geminiClient,
};

let runtimeOverride: ProviderName | null = null;

function normalizeProviderName(raw: string | undefined): ProviderName | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "openrouter" || v === "or") return "openrouter";
  if (v === "gemini" || v === "google" || v === "google-gemini") return "gemini";
  return null;
}

/**
 * Resolve which provider to use. Order:
 *   1. Explicit in-process override (set via `setLLMProvider`).
 *   2. `LLM_PROVIDER` env var.
 *   3. Default to OpenRouter.
 */
export function resolveProviderName(): ProviderName {
  if (runtimeOverride) return runtimeOverride;
  const fromEnv = normalizeProviderName(process.env.LLM_PROVIDER);
  if (fromEnv) return fromEnv;
  return "openrouter";
}

export function getLLMClient(): LLMClient {
  const name = resolveProviderName();
  const client = PROVIDERS[name];
  if (!client) {
    throw new Error(
      `Unknown LLM provider "${name}". Supported: ${Object.keys(PROVIDERS).join(", ")}.`
    );
  }
  return client;
}

/**
 * Pin the active provider from code (bypassing `LLM_PROVIDER`).
 * Pass `null` to revert to env-driven resolution. Primarily used by tests.
 */
export function setLLMProvider(provider: ProviderName | null): void {
  runtimeOverride = provider;
}

/** Convenience re-export so callers don't need to know the directory layout. */
export type { GenerateOptions, GenerateResult, LLMClient } from "./types";
export { OPENROUTER_MODEL_NAME } from "./openrouter";
export {
  GEMINI_MODEL_NAME,
  GeminiRateLimitError,
  _resetGeminiKeyCooldowns,
  _resetGeminiRoundRobinIndex,
  _resetGeminiEnvCache,
} from "./gemini";