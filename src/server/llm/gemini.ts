import "server-only";


import type { GenerateOptions, GenerateResult, LLMClient } from "./types";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_KEY_COOLDOWN_MS = 60_000;

let cachedBaseUrl: string | null = null;
let cachedKeyPool: string[] | null = null;
let lastKeyIndex: number = -1;
const keyCooldownUntil = new Map<string, number>();

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

export function _resetGeminiEnvCache(): void {
  cachedBaseUrl = null;
  cachedKeyPool = null;
}


export function _resetGeminiKeyCooldowns(): void {
  keyCooldownUntil.clear();
}

export function _resetGeminiRoundRobinIndex(): void {
  lastKeyIndex = -1;
}


function pickNextAvailableKey(pool: string[]): string | null {
  if (pool.length === 0) return null;
  const now = Date.now();
  for (let step = 0; step < pool.length; step++) {
    // Modulo also handles the initial -1 cleanly: (-1 + 1) % n === 0.
    lastKeyIndex = (lastKeyIndex + 1) % pool.length;
    const candidate = pool[lastKeyIndex];
    const until = keyCooldownUntil.get(candidate);
    if (until !== undefined && now < until) {
      continue;
    }
    if (until !== undefined) {
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

function classifyResponse(
  status: number,
  bodyText: string,
  parsedBody: unknown
): RateLimitSignal {
  if (status === 429) {
    return { rateLimited: true, retryAfterMs: null };
  }

  if (status === 503 && looksLikeQuotaError(parsedBody, bodyText)) {
    return { rateLimited: true, retryAfterMs: null };
  }

  if (looksLikeQuotaError(parsedBody, bodyText)) {
    return { rateLimited: true, retryAfterMs: null };
  }

  return { rateLimited: false, retryAfterMs: null };
}

function looksLikeQuotaError(parsedBody: unknown, bodyText: string): boolean {
  
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
    // Callers fall back to the raw text when parsedBody is null.
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

    // Round-robin across the key pool, bounded by pool size so a poison
    // key can't spin forever. On 429/quota we mark the key cooling-down
    // and let pickNextAvailableKey skip it on the next iteration.
    let lastAttempt: RawAttempt | null = null;

    for (let step = 0; step < keyPool.length; step++) {
      const apiKey = pickNextAvailableKey(keyPool);
      if (!apiKey) break;

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
        // Network/timeout failures are not rate-limit signals — surfacing
        // them immediately avoids burning healthy keys on a dead network.
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

      const signal = classifyResponse(
        attempt.status,
        attempt.bodyText,
        attempt.parsedBody
      );

      if (signal.rateLimited) {
        markKeyCoolingDown(apiKey, signal.retryAfterMs);
        continue;
      }

      throw new Error(
        `Gemini returned ${attempt.status} ${attempt.statusText} for model=${model}: ${attempt.bodyText.slice(
          0,
          500
        )}`
      );
    }

    throw new GeminiRateLimitError({
      attemptedKeys: keyPool.length,
      lastStatus: lastAttempt?.status ?? null,
      lastBodyExcerpt: lastAttempt?.bodyText.slice(0, 500) ?? "",
    });
  },
};

export const GEMINI_MODEL_NAME = DEFAULT_MODEL;