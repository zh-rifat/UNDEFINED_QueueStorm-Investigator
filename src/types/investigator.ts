/**
 * Domain types for the QueueStorm Investigator API.
 *
 * These mirror the JSON contract published in the SUST Hackathon Preliminary
 * problem statement (Sections 5, 6, 7). Variants are exhaustive — every value
 * a judge harness may send or expect lives here.
 */

// ---------- Enums (Section 7) ----------

export const CASE_TYPES = [
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "duplicate_payment",
  "merchant_settlement_delay",
  "agent_cash_in_issue",
  "phishing_or_social_engineering",
  "other",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

export const DEPARTMENTS = [
  "customer_support",
  "dispute_resolution",
  "payments_ops",
  "merchant_operations",
  "agent_operations",
  "fraud_risk",
] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const EVIDENCE_VERDICTS = [
  "consistent",
  "inconsistent",
  "insufficient_data",
] as const;
export type EvidenceVerdict = (typeof EVIDENCE_VERDICTS)[number];

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const LANGUAGES = ["en", "bn", "mixed"] as const;
export type Language = (typeof LANGUAGES)[number];

export const CHANNELS = [
  "in_app_chat",
  "call_center",
  "email",
  "merchant_portal",
  "field_agent",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const USER_TYPES = ["customer", "merchant", "agent", "unknown"] as const;
export type UserType = (typeof USER_TYPES)[number];

export const TXN_TYPES = [
  "transfer",
  "payment",
  "cash_in",
  "cash_out",
  "settlement",
  "refund",
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

export const TXN_STATUSES = [
  "completed",
  "failed",
  "pending",
  "reversed",
] as const;
export type TxnStatus = (typeof TXN_STATUSES)[number];

// ---------- Request DTO (Section 5) ----------

export type TransactionHistoryEntry = {
  transaction_id: string;
  timestamp: string; // ISO 8601
  type: TxnType;
  amount: number; // BDT
  counterparty: string;
  status: TxnStatus;
};

export type AnalyzeTicketRequest = {
  ticket_id: string;
  complaint: string;
  language?: Language;
  channel?: Channel;
  user_type?: UserType;
  campaign_context?: string;
  transaction_history?: TransactionHistoryEntry[];
  metadata?: Record<string, unknown>;
};

// ---------- Response DTO (Section 6) ----------

export type AnalyzeTicketResponse = {
  ticket_id: string;
  relevant_transaction_id: string | null;
  evidence_verdict: EvidenceVerdict;
  case_type: CaseType;
  severity: Severity;
  department: Department;
  agent_summary: string;
  recommended_next_action: string;
  customer_reply: string;
  human_review_required: boolean;
  confidence?: number;
  reason_codes?: string[];
};

// ---------- Type guards (lightweight runtime validation) ----------

export function isCaseType(value: unknown): value is CaseType {
  return typeof value === "string" && (CASE_TYPES as readonly string[]).includes(value);
}

export function isDepartment(value: unknown): value is Department {
  return typeof value === "string" && (DEPARTMENTS as readonly string[]).includes(value);
}

export function isEvidenceVerdict(value: unknown): value is EvidenceVerdict {
  return (
    typeof value === "string" &&
    (EVIDENCE_VERDICTS as readonly string[]).includes(value)
  );
}

export function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value);
}