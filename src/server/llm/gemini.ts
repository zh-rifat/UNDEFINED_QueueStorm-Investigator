import "server-only";

/**
 * Google Gemini provider — optional alternative to OpenRouter.
 *
 * Talks directly to the public `generativelanguage.googleapis.com`
 * `generateContent` REST endpoint with `responseMimeType: "application/json"`.
 * No SDK is used so the dependency surface stays small and the orchestrator
 * can switch providers without touching feature code.
 *
 * Multi-key rotation
 * ------------------
 * The `GEMINI_API_KEY` env var is parsed as a comma-separated list of keys
 * (whitespace around each entry is trimmed, blanks are dropped, duplicates
 * are de-duplicated while preserving first-seen order). On every call the
 * client picks the *next* key in the pool using a round-robin index cached
 * in module scope, so consecutive requests spread the load across the
 * configured keys and avoid hammering a single key into the rate limit.
 *
 * If the chosen key fails with HTTP 429 / `RESOURCE_EXHAUSTED` / a quota
 * message, the client:
 *
 *   1. Marks that key as cooling down for `GEMINI_KEY_COOLDOWN_MS`
 *      (default 60s).
 *   2. Advances the round-robin index to the next non-cooling-down key.
 *   3. Retries the same request (bounded by the pool size).
 *
 * If every key is exhausted, throws a typed `GeminiRateLimitError` so the
 * orchestrator can surface a clear `llm_failure` response.
 */

import type { GenerateOptions, GenerateResult, LLMClient } from "./types";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_KEY_COOLDOWN_MS = 60_000;

let cachedBaseUrl: string | null = null;

/**
 * Ordered list of Gemini API keys parsed from the comma-separated
 * `GEMINI_API_KEY` env var. Order is preserved (after trim + dedupe) so the
 * round-robin walks keys deterministically.
 */
let cachedKeyPool: string[] | null = null;

/**
 * Round-robin cursor pointing at the index of the key most recently picked
 * from the pool. Starts at `-1` so the very first call advances to index 0.
 * The value is module-scoped — within a single Node process it survives
 * across requests, giving us a per-process sticky rotation that spreads
 * load evenly. `_resetGeminiRoundRobinIndex()` resets it for tests.
 */
let lastKeyIndex: number = -1;

/**
 * Per-key cooldown bookkeeping. `keyCooldownUntil.get(apiKey)` holds the
 * epoch-ms timestamp until which the key is considered unavailable. We avoid
 * exposing the raw map outside the module; `_resetGeminiKeyCooldowns()` is the
 * only escape hatch and is intended for tests.
 */
const keyCooldownUntil = new Map<string, number>();

/**
 * Typed error so callers (the orchestrator, tests) can distinguish a
 * "every key is rate-limited" outcome from a generic upstream failure.
 */
export class GeminiRateLimitError extends Error {
  readonly provider = "gemini";
  readonly attemptedKeys: number;
  readonly lastStatus: number | null;
  readonly lastBodyExcerpt: string;

  constructor(args: {
    attemptedKeys: number;
    lastStatus: number | null;
    lastBodyExcerpt: string;
    cause?: unknown;
  }) {
    const summary =
      args.lastStatus !== null
        ? `last status=${args.lastStatus}`
        : "no successful response";
    super(
      `Gemini rate-limited across ${args.attemptedKeys} key(s); ${summary}. ` +
        `Wait a moment or add more GEMINI_API_KEY* entries before retrying.`
    );
    this.name = "GeminiRateLimitError";
    this.attemptedKeys = args.attemptedKeys;
    this.lastStatus = args.lastStatus;
    this.lastBodyExcerpt = args.lastBodyExcerpt;
    if (args.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = args.cause;
    }
  }
}

function readEnv(): { baseUrl: string; keyPool: string[] } {
  if (cachedBaseUrl && cachedKeyPool) {
    return { baseUrl: cachedBaseUrl, keyPool: cachedKeyPool };
  }
  const keyPool = collectKeyPool();
  if (keyPool.length === 0) {
    throw new Error(
      "No Gemini API key is configured. Set GEMINI_API_KEY as a comma-" +
        "separated list (e.g. `GEMINI_API_KEY=key1,key2,key3`) in .env or" +
        " your deployment environment."
    );
  }
  const baseUrl = (process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL).replace(
    /\/+$/,
    ""
  );
  cachedKeyPool = keyPool;
  cachedBaseUrl = baseUrl;
  return { baseUrl, keyPool };
}

/**
 * Parse `GEMINI_API_KEY` as a comma-separated list of API keys. Whitespace
 * around each entry is trimmed, blank entries are dropped, and duplicates
 * are filtered out while preserving the first-seen order. This gives the
 * caller a stable rotation sequence.
 *
 * Example: `GEMINI_API_KEY=key-a, key-b,,key-a` → `["key-a", "key-b"]`.
 */
function collectKeyPool(): string[] {
  const raw = process.env.GEMINI_API_KEY ?? "";
  if (!raw.trim()) return [];

  const seen = new Set<string>();
  const pool: string[] = [];
  for (const part of raw.split(",")) {
    const value = part.trim();
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    pool.push(value);
  }
  return pool;
}

/**
 * Tests (and hot-reload flows) call this to force the next request to
 * re-read `process.env` and rebuild the key pool.
 */
export function _resetGeminiEnvCache(): void {
  cachedBaseUrl = null;
  cachedKeyPool = null;
}

/**
 * Tests call this to clear in-memory cooldown timestamps without resetting
 * the key-pool cache.
 */
export function _resetGeminiKeyCooldowns(): void {
  keyCooldownUntil.clear();
}

/**
 * Tests call this to reset the round-robin cursor back to its initial
 * pre-rotation state, so the next request picks index 0 again.
 */
export function _resetGeminiRoundRobinIndex(): void {
  lastKeyIndex = -1;
}

/**
 * Advance the round-robin cursor past any keys currently cooling down and
 * return the next available key. If every key is cooling down, returns
 * `null` and the caller should surface `GeminiRateLimitError`.
 *
 * Skips past cooling-down entries instead of *picking* one and waiting, so
 * we never silently send a request to a known-bad key.
 */
function pickNextAvailableKey(pool: string[]): string | null {
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let step = 0; step < pool.length; step++) {
    // Modulo so we wrap; this also handles the initial `-1` cleanly:
    // (-1 + 1) % n === 0 on the first call.
    lastKeyIndex = (lastKeyIndex + 1) % pool.length;
    const candidate = pool[lastKeyIndex];
    const until = keyCooldownUntil.get(candidate);
    if (until !== undefined && now < until) {
      // Key is cooling down — keep walking.
      continue;
    }
    if (until !== undefined) {
      // Cooldown expired — clear the stale entry and pick it.
      keyCooldownUntil.delete(candidate);
    }
    return candidate;
  }
  return null;
}

function getKeyCooldownMs(): number {
  const raw = process.env.GEMINI_KEY_COOLDOWN_MS;
  if (!raw) return DEFAULT_KEY_COOLDOWN_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_KEY_COOLDOWN_MS;
  return Math.min(parsed, 600_000); // cap at 10 minutes
}

function getModelName(override?: string): string {
  return override || process.env.GEMINI_MODEL || DEFAULT_MODEL;
}

function getMaxTokens(): number {
  const raw = process.env.GEMINI_MAX_TOKENS;
  if (!raw) return DEFAULT_MAX_TOKENS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TOKENS;
}

function getTemperature(): number {
  const raw = process.env.GEMINI_TEMPERATURE;
  if (!raw) return DEFAULT_TEMPERATURE;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TEMPERATURE;
}

function getTimeoutMs(): number {
  const raw = process.env.GEMINI_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, 300_000);
}

type RateLimitSignal = {
  rateLimited: boolean;
  retryAfterMs: number | null;
};

/**
 * Inspect the raw response status + body and decide whether this attempt
 * should trigger rotation. Gemini surfaces quota exhaustion in two shapes:
 *
 *   - HTTP 429 with a JSON error envelope whose `error.code` is
 *     `RESOURCE_EXHAUSTED` or whose `status` is `UNAVAILABLE`.
 *   - A non-2xx response whose message matches `/rate limit|quota|resource
 *     exhausted/i`.
 *
 * The Google API also includes a `Retry-After` header on some 429s; we
 * surface it as a hint for the cooldown duration.
 */
function classifyResponse(
  status: number,
  bodyText: string,
  parsedBody: unknown
): RateLimitSignal {
  // HTTP 429 is the canonical "you're rate-limited" signal — always rotate.
  if (status === 429) {
    return { rateLimited: true, retryAfterMs: null };
  }

  // Some Gemini endpoints return 503 when the upstream pool is saturated.
  if (status === 503) {
    if (looksLikeQuotaError(parsedBody, bodyText)) {
      return { rateLimited: true, retryAfterMs: null };
    }
  }

  // Error envelopes (HTTP non-2xx OR 2xx-with-`error`-field) carry the
  // RESOURCE_EXHAUSTED code or a quota-related message — those also rotate.
  if (looksLikeQuotaError(parsedBody, bodyText)) {
    return { rateLimited: true, retryAfterMs: null };
  }

  return { rateLimited: false, retryAfterMs: null };
}

function looksLikeQuotaError(parsedBody: unknown, bodyText: string): boolean {
  // The body is sometimes plain-text on 4xx responses, so we look at both
  // the structured envelope and the raw text.
  if (parsedBody && typeof parsedBody === "object") {
    const env = parsedBody as {
      error?: { code?: number | string; status?: string; message?: string };
    };
    const code = env.error?.code;
    const status = env.error?.status;
    if (
      code === "RESOURCE_EXHAUSTED" ||
      code === 8 || // proto enum value for RESOURCE_EXHAUSTED
      status === "RESOURCE_EXHAUSTED" ||
      status === "UNAVAILABLE"
    ) {
      return true;
    }
    const message = env.error?.message;
    if (typeof message === "string" && QUOTA_MESSAGE.test(message)) {
      return true;
    }
  }
  return QUOTA_MESSAGE.test(bodyText);
}

const QUOTA_MESSAGE =
  /rate[_ ]limit|quota|resource[_ ]exhausted|too many requests/i;

function markKeyCoolingDown(apiKey: string, retryAfterMs: number | null): void {
  const cooldownMs = retryAfterMs ?? getKeyCooldownMs();
  keyCooldownUntil.set(apiKey, Date.now() + cooldownMs);
}

type RawAttempt = {
  status: number;
  statusText: string;
  bodyText: string;
  parsedBody: unknown;
};

async function attemptRequest(
  apiKey: string,
  baseUrl: string,
  model: string,
  body: unknown,
  timeoutMs: number,
  signal: AbortSignal
): Promise<RawAttempt> {
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        cache: "no-store",
        headers: {
          "x-goog-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      }
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Gemini request timed out after ${timeoutMs}ms (model=${model})`
      );
    }
    throw new Error(
      `Gemini request failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }

  let bodyText: string;
  try {
    bodyText = await response.text();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(
        `Gemini response read timed out after ${timeoutMs}ms (model=${model})`
      );
    }
    throw new Error(
      `Gemini response read failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`
    );
  }

  let parsedBody: unknown = null;
  try {
    parsedBody = bodyText.length > 0 ? JSON.parse(bodyText) : null;
  } catch {
    // Leave parsedBody as null; callers will fall back to the raw text.
  }

  return {
    status: response.status,
    statusText: response.statusText,
    bodyText,
    parsedBody,
  };
}

function buildRequestBody(options: GenerateOptions) {
  return {
    systemInstruction: {
      role: "system",
      parts: [{ text: options.system }],
    },
    contents: [
      {
        role: "user",
        parts: [{ text: options.user }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: getTemperature(),
      topP: 0.8,
      maxOutputTokens: getMaxTokens(),
    },
  };
}

function parseSuccessPayload(
  model: string,
  bodyText: string,
  parsedBody: unknown
): GenerateResult {
  const envelope = parsedBody as {
    modelVersion?: string;
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
    error?: { message?: string; code?: number | string; status?: string };
  };

  if (envelope && envelope.error && typeof envelope.error === "object") {
    const message =
      typeof envelope.error.message === "string"
        ? envelope.error.message
        : "unknown error";
    const code =
      envelope.error.code !== undefined
        ? String(envelope.error.code)
        : "unknown";
    throw new Error(
      `Gemini API error (model=${envelope.modelVersion ?? model}, code=${code}): ${message}`
    );
  }

  const firstCandidate = envelope?.candidates?.[0];
  const rawText = firstCandidate?.content?.parts
    ?.map((p) => p.text ?? "")
    .join("");
  if (typeof rawText !== "string" || rawText.length === 0) {
    const finishReason = firstCandidate?.finishReason ?? "no_candidates";
    throw new Error(
      `Gemini response had no assistant content (model=${
        envelope?.modelVersion ?? model
      }, finish_reason=${finishReason}): ${bodyText.slice(0, 500)}`
    );
  }

  return {
    rawText,
    model: envelope?.modelVersion ?? model,
    finishReason: firstCandidate?.finishReason ?? null,
    usage: {
      promptTokens: envelope?.usageMetadata?.promptTokenCount ?? null,
      completionTokens: envelope?.usageMetadata?.candidatesTokenCount ?? null,
      totalTokens: envelope?.usageMetadata?.totalTokenCount ?? null,
    },
  };
}

export const geminiClient: LLMClient = {
  provider: "gemini",

  async generateInvestigatorCompletion(
    options: GenerateOptions
  ): Promise<GenerateResult> {
    const { baseUrl, keyPool } = readEnv();
    const model = getModelName(options.model);
    const timeoutMs = getTimeoutMs();
    const body = buildRequestBody(options);

    // Round-robin: pick the next available key once per request. If that
    // key 429s, mark it cooling-down, advance the cursor, and retry. We
    // bound retries by the pool size so we never spin forever even if every
    // key is bad.
    let lastAttempt: RawAttempt | null = null;

    for (let step = 0; step < keyPool.length; step++) {
      const apiKey = pickNextAvailableKey(keyPool);
      if (!apiKey) break; // every key is cooling down → bail out below

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let attempt: RawAttempt;
      try {
        attempt = await attemptRequest(
          apiKey,
          baseUrl,
          model,
          body,
          timeoutMs,
          controller.signal
        );
      } catch (err) {
        clearTimeout(timer);
        // Network/timeout errors aren't rate-limit signals — surface them
        // immediately rather than burning the next key.
        throw err;
      }
      clearTimeout(timer);

      lastAttempt = attempt;

      if (!attempt.status || attempt.status < 400) {
        if (attempt.bodyText.length === 0) {
          throw new Error(
            `Gemini returned an empty body for model=${model} (status=${attempt.status})`
          );
        }
        if (attempt.parsedBody === null) {
          throw new Error(
            `Gemini returned non-JSON response for model=${model}: ${attempt.bodyText.slice(
              0,
              500
            )}`
          );
        }
        return parseSuccessPayload(model, attempt.bodyText, attempt.parsedBody);
      }

      // Non-2xx — decide whether to rotate.
      const signal = classifyResponse(
        attempt.status,
        attempt.bodyText,
        attempt.parsedBody
      );

      if (signal.rateLimited) {
        markKeyCoolingDown(apiKey, signal.retryAfterMs);
        // Loop continues — pickNextAvailableKey will skip the cooling-down
        // key and advance to the next pool entry on the next iteration.
        continue;
      }

      // Non-rate-limit failure — surface it as-is.
      throw new Error(
        `Gemini returned ${attempt.status} ${attempt.statusText} for model=${model}: ${attempt.bodyText.slice(
          0,
          500
        )}`
      );
    }

    // Every key was either rate-limited or otherwise unavailable. Surface
    // a typed error so the orchestrator can decide on the response shape.
    throw new GeminiRateLimitError({
      attemptedKeys: keyPool.length,
      lastStatus: lastAttempt?.status ?? null,
      lastBodyExcerpt: lastAttempt?.bodyText.slice(0, 500) ?? "",
    });
  },
};

export const GEMINI_MODEL_NAME = DEFAULT_MODEL;