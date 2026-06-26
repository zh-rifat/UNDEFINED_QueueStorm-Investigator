import {
  CASE_TYPES,
  DEPARTMENTS,
  EVIDENCE_VERDICTS,
  SEVERITIES,
  type AnalyzeTicketResponse,
  type CaseType,
  type Department,
  type EvidenceVerdict,
  type Severity,
} from "@/types/investigator";

/**
 * Robust JSON parser for the model output.
 *
 * The Gemini API is configured with `responseMimeType: "application/json"`,
 * but in practice the model can still occasionally:
 *   - Wrap the JSON in ```json fences (older configs).
 *   - Prepend a short preamble.
 *   - Trailing whitespace or extra braces.
 *
 * This parser tries three strategies in order:
 *   1. JSON.parse the raw text.
 *   2. Strip markdown fences and retry.
 *   3. Extract the first {...} block and retry.
 */

export type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseModelJson(raw: string): ParseResult {
  const trimmed = raw.trim();

  // Strategy 1: direct parse.
  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  // Strategy 2: strip ```json fences.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    const attempt = tryParse(fenced);
    if (attempt.ok) return attempt;
  }

  // Strategy 3: extract first balanced {...} block.
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    const attempt = tryParse(slice);
    if (attempt.ok) return attempt;
  }

  return {
    ok: false,
    error: direct.error || "Model output was not valid JSON",
  };
}

function tryParse(text: string): ParseResult {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown> };
    }
    return { ok: false, error: "Model output was not a JSON object" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown JSON parse error",
    };
  }
}

// ---------- Coercion helpers ----------

function clamp(value: unknown, fallback: number, min = 0, max = 1): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === "string");
  return filtered.length > 0 ? filtered : undefined;
}

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

export type NormalizedResponse = AnalyzeTicketResponse & {
  safetyFlags: number;
};

/**
 * Normalize the raw model JSON into a strict response object that matches the
 * API contract exactly. Unknown enum values fall back to safe defaults rather
 * than crashing the request — this preserves uptime during a hidden test spike.
 */
export function normalizeModelOutput(
  ticketId: string,
  raw: Record<string, unknown>
): NormalizedResponse {
  const caseType: CaseType =
    pickEnum(raw.case_type, CASE_TYPES) ?? "other";
  const department: Department = pickEnum(raw.department, DEPARTMENTS) ?? (
    caseType === "wrong_transfer"
      ? "dispute_resolution"
      : caseType === "payment_failed" || caseType === "duplicate_payment"
      ? "payments_ops"
      : caseType === "phishing_or_social_engineering"
      ? "fraud_risk"
      : "customer_support"
  );
  const evidenceVerdict: EvidenceVerdict =
    pickEnum(raw.evidence_verdict, EVIDENCE_VERDICTS) ?? "insufficient_data";
  const severity: Severity = pickEnum(raw.severity, SEVERITIES) ?? "medium";

  const relevantTransactionId =
    typeof raw.relevant_transaction_id === "string"
      ? raw.relevant_transaction_id
      : raw.relevant_transaction_id === null
      ? null
      : null;

  return {
    ticket_id: asString(raw.ticket_id, ticketId) || ticketId,
    relevant_transaction_id: relevantTransactionId,
    evidence_verdict: evidenceVerdict,
    case_type: caseType,
    severity,
    department,
    agent_summary: asString(raw.agent_summary, "Case summarized for agent review."),
    recommended_next_action: asString(
      raw.recommended_next_action,
      "Escalate to the appropriate department for human review."
    ),
    customer_reply: asString(
      raw.customer_reply,
      "Thank you for contacting us. Our support team will review your case and respond through our official channels."
    ),
    human_review_required:
      typeof raw.human_review_required === "boolean"
        ? raw.human_review_required
        : severity === "high" || severity === "critical" || evidenceVerdict !== "consistent",
    confidence: clamp(raw.confidence, 0.6),
    reason_codes: asStringArray(raw.reason_codes),
    safetyFlags: 0,
  };
}