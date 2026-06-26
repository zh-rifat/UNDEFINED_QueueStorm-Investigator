/**
 * Safety guardrails (Section 8 of the problem statement).
 *
 * Three automated checks enforced here:
 *   1. Never request PIN / OTP / password / full card number.
 *   2. Never confirm a refund, reversal, account unblock, or recovery.
 *   3. Never instruct the customer to contact a suspicious third party.
 *
 * The checks run over BOTH `customer_reply` AND `recommended_next_action`
 * because either field can leak the same dangerous language.
 *
 * When the judge harness flags violations we subtract from the safety score,
 * so the goal is to make these checks tight and deterministic rather than
 * relying on prompt-level niceness.
 */

const CREDENTIAL_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "PIN request", pattern: /\b(pin|personal\s+identification\s+number)\b/i },
  { label: "OTP request", pattern: /\b(otp|one[\s-]?time\s+(?:password|code|pin))\b/i },
  { label: "password request", pattern: /\b(password|passwd|pwd)\b/i },
  { label: "CVV request", pattern: /\b(cvv|cvc|card\s+security\s+code)\b/i },
  { label: "full card number request", pattern: /\b(full\s+card\s+(?:number|no)|16[\s-]?digit\s+card\s+number)\b/i },
];

const REFUND_CONFIRMATION_PATTERNS: RegExp[] = [
  /\bwe\s+(?:will|shall|are\s+going\s+to)\s+refund\b/i,
  /\brefund\s+(?:has\s+been|will\s+be)\s+(?:processed|approved|initiated|completed)\b/i,
  /\bwe\s+have\s+(?:already\s+)?refunded\b/i,
  /\bmoney\s+will\s+be\s+returned\s+(?:to\s+you\s+)?immediately\b/i,
  /\bguarantee(?:d|s)?\s+refund\b/i,
  /\bwe\s+will\s+reverse\s+the\s+(?:transaction|payment|transfer)\b/i,
  /\baccount\s+(?:will|shall)\s+be\s+unblocked\b/i,
  /\bwe\s+will\s+recover\s+your\s+(?:money|funds|balance)\b/i,
];

/**
 * Phrases that point the customer at a third party the platform cannot vouch for.
 * Official channels (in-app help, official hotline, branch, website domain)
 * are explicitly allowed and are NOT flagged.
 */
const SUSPICIOUS_REFERRAL_PATTERNS: RegExp[] = [
  /\bcontact\s+(?:the\s+)?(?:recipient|sender|buyer|seller|merchant|agent)\s+directly\b/i,
  /\bcall\s+(?:the\s+)?(?:number|person|recipient|merchant)\s+(?:at|on)\s+\+?\d/i,
  /\bmeet\s+(?:the\s+)?(?:recipient|sender|agent)\s+in\s+person\b/i,
  /\bshare\s+(?:this|your)\s+(?:code|number|details)\s+with\s+(?:the\s+)?(?:recipient|sender|agent)\b/i,
];

export type SafetyFlag = {
  field: "customer_reply" | "recommended_next_action";
  rule:
    | "credential_request"
    | "refund_confirmation"
    | "suspicious_third_party";
  label: string;
  match: string;
};

export function scanText(
  field: "customer_reply" | "recommended_next_action",
  text: string
): SafetyFlag[] {
  const flags: SafetyFlag[] = [];

  for (const { label, pattern } of CREDENTIAL_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      flags.push({
        field,
        rule: "credential_request",
        label,
        match: m[0],
      });
    }
  }

  for (const pattern of REFUND_CONFIRMATION_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      flags.push({
        field,
        rule: "refund_confirmation",
        label: "Unauthorized refund/reversal commitment",
        match: m[0],
      });
    }
  }

  for (const pattern of SUSPICIOUS_REFERRAL_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      flags.push({
        field,
        rule: "suspicious_third_party",
        label: "Referral to suspicious third party",
        match: m[0],
      });
    }
  }

  return flags;
}

/**
 * Strict, safe fallback text used when the model's draft fails a safety scan.
 * The fallback never requests credentials, never confirms refunds, and only
 * directs the customer to official support channels.
 */
export const SAFE_CUSTOMER_REPLY_FALLBACK =
  "Thank you for contacting us. We have logged your concern and a support agent will review your case. For your safety, please only share information through our official app or verified support channels, and never share your PIN, OTP, or password with anyone.";

export const SAFE_NEXT_ACTION_FALLBACK =
  "Escalate to the appropriate department for human review; do not request credentials from the customer and do not confirm any refund outside of official channels.";