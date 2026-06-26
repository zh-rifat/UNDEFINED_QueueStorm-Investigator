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


export type ParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export function parseModelJson(raw: string): ParseResult {
  const trimmed = raw.trim();

  const direct = tryParse(trimmed);
  if (direct.ok) return direct;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    const fenced = fenceMatch[1].trim();
    const attempt = tryParse(fenced);
    if (attempt.ok) return attempt;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const slice = trimmed.slice(firstBrace, lastBrace + 1);
    const attempt = tryParse(slice);
    if (attempt.ok) return attempt;
  }

  const repaired = repairUnterminatedStrings(trimmed);
  if (repaired) {
    const attempt = tryParse(repaired);
    if (attempt.ok) return attempt;
  }

  const salvaged = salvageFields(trimmed);
  if (salvaged && Object.keys(salvaged).length > 0) {
    return { ok: true, value: salvaged };
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

/**
 * Escape `"` characters that appear inside a JSON string but are NOT
 * structural delimiters. Returns the repaired text, or null if no fix was
 * applied.
 *
 * A structural `"` after a string value is one that is followed (optionally
 * with whitespace) by `,`, `}`, `]`, `:`. Anything else inside a string is an
 * embedded quote that should be escaped.
 */
function repairUnterminatedStrings(text: string): string | null {
  let out = "";
  let inString = false;
  let escapeNext = false;
  let fixed = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      out += ch;
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      if (!inString) {
        // Opening a string — always accept.
        inString = true;
        out += ch;
        continue;
      }

      // We are inside a string. Decide whether this `"` is closing the
      // string (followed by a structural delimiter) or is an embedded quote.
      const lookahead = peekAhead(text, i + 1);
      if (isStructuralDelimiter(lookahead)) {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
        fixed = true;
      }
      continue;
    }

    out += ch;
  }

  // If we ended still inside a string, the response was truncated. Close it
  // and any open braces so the JSON parses.
  if (inString) {
    out += '"';
    fixed = true;
  }
  // Walk back through `out` to count how many unclosed `{` and `[` remain.
  // We only count structural opens/closes outside of strings.
  const stack: string[] = [];
  let escape2 = false;
  let inStr2 = false;
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (escape2) {
      escape2 = false;
      continue;
    }
    if (c === "\\") {
      escape2 = true;
      continue;
    }
    if (c === '"') {
      inStr2 = !inStr2;
      continue;
    }
    if (inStr2) continue;
    if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  if (stack.length > 0) {
    // Strip any trailing comma before closing.
    out = out.replace(/,\s*$/, "");
    out += stack.reverse().join("");
    fixed = true;
  }
  if (fixed) {
    // Tidy up trailing commas introduced by the repair.
    out = out.replace(/,(\s*[}\]])/g, "$1");
  }

  return fixed ? out : null;
}

function peekAhead(text: string, from: number): string {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] ?? "";
}

function isStructuralDelimiter(ch: string): boolean {
  return ch === "," || ch === "}" || ch === "]" || ch === ":";
}

/**
 * Last-resort salvage: extract every `"key": value` pair from the raw text,
 * treating each value independently. Strings, numbers, booleans, nulls, and
 * arrays are all supported. Anything that cannot be parsed is skipped.
 */
function salvageFields(text: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};
  let found = false;

  // Match `"key":` followed by either a quoted string, a primitive, or an
  // array. We do this iteratively with a manual scanner so we can handle
  // arbitrarily long string values that contain escaped quotes.
  const scanner = new FieldScanner(text);
  while (!scanner.eof()) {
    scanner.skipWhitespace();
    const key = scanner.readKey();
    if (!key) break;
    scanner.skipWhitespace();
    if (scanner.peek() !== ":") {
      scanner.advance();
      continue;
    }
    scanner.advance(); // consume `:`
    scanner.skipWhitespace();
    const value = scanner.readValue();
    if (value !== undefined) {
      result[key] = value.value;
      found = true;
    }
  }

  return found ? result : null;
}

class FieldScanner {
  private i = 0;
  constructor(private readonly text: string) {}

  eof(): boolean {
    return this.i >= this.text.length;
  }

  peek(): string {
    return this.text[this.i] ?? "";
  }

  advance(): void {
    this.i++;
  }

  skipWhitespace(): void {
    while (this.i < this.text.length && /\s/.test(this.text[this.i])) {
      this.i++;
    }
  }

  readKey(): string | null {
    if (this.peek() !== '"') return null;
    this.advance();
    let key = "";
    while (this.i < this.text.length && this.text[this.i] !== '"') {
      key += this.text[this.i];
      this.i++;
    }
    if (this.peek() === '"') this.advance();
    return key.length > 0 ? key : null;
  }

  /**
   * Read one JSON value starting at the current cursor.
   * Returns `{ value: <parsed> }` on success, `undefined` on failure.
   */
  readValue(): { value: unknown } | undefined {
    const ch = this.peek();
    if (ch === '"') return this.readStringValue();
    if (ch === "{" || ch === "[") return this.readComposite();
    return this.readPrimitive();
  }

  private readStringValue(): { value: string } | undefined {
    if (this.peek() !== '"') return undefined;
    this.advance();
    let out = "";
    let escape = false;
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (escape) {
        // Pass through common escapes literally.
        out += c;
        escape = false;
        this.i++;
        continue;
      }
      if (c === "\\") {
        out += c;
        escape = true;
        this.i++;
        continue;
      }
      if (c === '"') {
        // Lookahead: if the next non-whitespace char is a structural
        // delimiter (`,`, `}`, `]`), this quote closes the string. Otherwise
        // it is an embedded quote and we keep it as a literal.
        const next = peekNonWhitespace(this.text, this.i + 1);
        if (next === "," || next === "}" || next === "]" || next === "") {
          this.advance(); // consume closing quote
          return { value: out };
        }
        out += '"';
        this.advance();
        continue;
      }
      out += c;
      this.advance();
    }
    // Truncated string — salvage what we have rather than dropping the field.
    return { value: out };
  }

  private readComposite(): { value: unknown } | undefined {
    // Try a strict JSON parse on the balanced slice starting here.
    const open = this.peek();
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    const start = this.i;
    for (let j = this.i; j < this.text.length; j++) {
      const c = this.text[j];
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          const slice = this.text.slice(start, j + 1);
          try {
            const parsed = JSON.parse(slice);
            this.i = j + 1;
            return { value: parsed };
          } catch {
            // Fall through to "drop this composite".
            this.i = j + 1;
            return undefined;
          }
        }
      }
    }
    return undefined;
  }

  private readPrimitive(): { value: unknown } | undefined {
    let buf = "";
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (c === "," || c === "}" || c === "]") break;
      buf += c;
      this.i++;
    }
    const token = buf.trim();
    if (token === "true") return { value: true };
    if (token === "false") return { value: false };
    if (token === "null") return { value: null };
    if (/^-?\d+(\.\d+)?$/.test(token)) return { value: Number(token) };
    return undefined;
  }
}

function peekNonWhitespace(text: string, from: number): string {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] ?? "";
}

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