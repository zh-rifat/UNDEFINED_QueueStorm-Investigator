import { getLLMClient } from "@/server/llm";
import { buildInvestigatorPrompt } from "@/features/investigator/prompt";
import {
  normalizeModelOutput,
  parseModelJson,
  type NormalizedResponse,
} from "@/features/investigator/parser";
import {
  scanText,
  SAFE_NEXT_ACTION_FALLBACK,
  pickSafeCustomerReplyFallback,
} from "@/features/investigator/safety";
import type {
  AnalyzeTicketRequest,
  AnalyzeTicketResponse,
} from "@/types/investigator";

export class AnalyzeTicketError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missing_ticket_id"
      | "empty_complaint"
      | "llm_failure"
      | "malformed_model_output"
  ) {
    super(message);
  }
}

export async function runAnalyzeTicketCore(
  request: AnalyzeTicketRequest
): Promise<AnalyzeTicketResponse> {
  if (!request || typeof request !== "object") {
    throw new AnalyzeTicketError(
      "Request body must be a JSON object",
      "empty_complaint"
    );
  }
  if (!request.ticket_id || typeof request.ticket_id !== "string") {
    throw new AnalyzeTicketError("ticket_id is required", "missing_ticket_id");
  }
  if (!request.complaint || typeof request.complaint !== "string") {
    throw new AnalyzeTicketError("complaint is required", "empty_complaint");
  }
  if (request.complaint.trim().length === 0) {
    throw new AnalyzeTicketError("complaint cannot be empty", "empty_complaint");
  }

  const { system, user } = buildInvestigatorPrompt(request);

  // Provider selection (openrouter / gemini) is owned by `src/server/llm`.
  // The Gemini client does round-robin rotation across the comma-separated
  // GEMINI_API_KEY pool so consecutive requests spread load across keys.
  let rawText: string;
  try {
    const client = getLLMClient();
    const result = await client.generateInvestigatorCompletion({ system, user });
    rawText = result.rawText;
  } catch (err) {
    throw new AnalyzeTicketError(
      `LLM call failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      "llm_failure"
    );
  }

  const parsed = parseModelJson(rawText);
  if (!parsed.ok) {
    throw new AnalyzeTicketError(
      `Model output could not be parsed: ${parsed.error}`,
      "malformed_model_output"
    );
  }

  const normalized: NormalizedResponse = normalizeModelOutput(
    request.ticket_id,
    parsed.value
  );

  const replyFlags = scanText("customer_reply", normalized.customer_reply);
  const actionFlags = scanText(
    "recommended_next_action",
    normalized.recommended_next_action
  );
  const allFlags = [...replyFlags, ...actionFlags];

  if (allFlags.length > 0) {
    // Always rewrite unsafe text to the strict fallback — never trust the draft.
    // pickSafeCustomerReplyFallback preserves the input language so a Bangla
    // complaint stays in Bangla after a safety rewrite.
    normalized.customer_reply = pickSafeCustomerReplyFallback(
      request.language
    );
    normalized.recommended_next_action = SAFE_NEXT_ACTION_FALLBACK;
    normalized.human_review_required = true;
  }

  const { safetyFlags: _ignored, ...response } = normalized;
  void _ignored;

  return response;
}
