import "server-only";
import type { GenerateOptions, GenerateResult, LLMClient } from "./types";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;

let cachedBaseUrl: string | null = null;
let cachedApiKey: string | null = null;

function readEnv(): { baseUrl: string; apiKey: string } {
  if (cachedBaseUrl && cachedApiKey) {
    return { baseUrl: cachedBaseUrl, apiKey: cachedApiKey };
  }
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured. Set it in .env or your deployment environment."
    );
  }
  const baseUrl = (
    process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL
  ).replace(/\/+$/, "");
  cachedApiKey = apiKey;
  cachedBaseUrl = baseUrl;
  return { baseUrl, apiKey };
}

/** Reset the cached env values (tests that mutate `process.env`). */
export function _resetOpenRouterEnvCache() {
  cachedBaseUrl = null;
  cachedApiKey = null;
}

function getModelName(override?: string): string {
  return override || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function getMaxTokens(): number {
  const raw = process.env.OPENROUTER_MAX_TOKENS;
  if (!raw) return DEFAULT_MAX_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function getTemperature(): number {
  const raw = process.env.OPENROUTER_TEMPERATURE;
  if (!raw) return DEFAULT_TEMPERATURE;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TEMPERATURE;
}

function getTimeoutMs(): number {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 300_000);
}

export const openrouterClient: LLMClient = {
  provider: "openrouter",

  async generateInvestigatorCompletion(
    options: GenerateOptions
  ): Promise<GenerateResult> {
    const { baseUrl, apiKey } = readEnv();
    const model = getModelName(options.model);

    const timeoutMs = getTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          // Recommended OpenRouter headers — help with attribution and lets
          // free-tier providers see the calling app.
          "HTTP-Referer":
            process.env.OPENROUTER_REFERER || "https://zhrifat.me",
          "X-Title":
            process.env.OPENROUTER_APP_TITLE || "QueueStorm Investigator",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: options.user },
          ],
          temperature: getTemperature(),
          max_tokens: getMaxTokens(),
          stream: false,
          top_p: 0.8,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `OpenRouter request timed out after ${timeoutMs}ms (model=${model})`
        );
      }
      throw new Error(
        `OpenRouter request failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(
          `OpenRouter response read timed out after ${timeoutMs}ms (model=${model})`
        );
      }
      throw new Error(
        `OpenRouter response read failed: ${
          err instanceof Error ? err.message : "unknown error"
        }`
      );
    }
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(
        `OpenRouter returned ${response.status} ${response.statusText} for model=${model}: ${responseText.slice(
          0,
          500
        )}`
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(responseText);
    } catch {
      throw new Error(
        `OpenRouter returned non-JSON response for model=${model}: ${responseText.slice(
          0,
          500
        )}`
      );
    }

    const completion = payload as {
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
      
      error?: { message?: string; code?: number | string; type?: string };
    };

    if (completion.error && typeof completion.error === "object") {
      const upstreamMessage =
        typeof completion.error.message === "string"
          ? completion.error.message
          : "unknown upstream error";
      const upstreamCode =
        completion.error.code !== undefined
          ? String(completion.error.code)
          : "unknown";
      throw new Error(
        `OpenRouter upstream error (model=${
          completion.model ?? model
        }, code=${upstreamCode}): ${upstreamMessage}`
      );
    }

    const firstChoice = completion.choices?.[0];
    const rawText = firstChoice?.message?.content;
    if (typeof rawText !== "string" || rawText.length === 0) {
      const finishReason = firstChoice?.finish_reason ?? "no_choices";
      throw new Error(
        `OpenRouter response had no assistant content (model=${
          completion.model ?? model
        }, finish_reason=${finishReason}): ${responseText.slice(0, 500)}`
      );
    }

    return {
      rawText,
      model: completion.model ?? model,
      finishReason: firstChoice?.finish_reason ?? null,
      usage: {
        promptTokens: completion.usage?.prompt_tokens ?? null,
        completionTokens: completion.usage?.completion_tokens ?? null,
        totalTokens: completion.usage?.total_tokens ?? null,
      },
    };
  },
};

export const OPENROUTER_MODEL_NAME = DEFAULT_MODEL;
export const OPENROUTER_BASE_URL = DEFAULT_BASE_URL;