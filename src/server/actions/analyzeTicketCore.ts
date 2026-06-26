/**
 * Pure orchestrator logic for analyzing a support ticket.
 *
 * This is the same code path as `analyzeTicketAction` (the `server-only`
 * action exported from `./analyzeTicket.ts`), minus the `server-only` guard.
 * It exists so test runners and other Node-only entry points can exercise
 * the full prompt -> model -> parse -> normalize -> safety pipeline without
 * triggering the Next.js `server-only` module guard.
 *
 * The `server-only` action is a thin wrapper around this function and
 * delegates immediately to `runAnalyzeTicketCore`.
 */

import { getGenerativeModel } from "@/server/gemini";
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
  // ---------- 1. Light input validation ----------
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

  // ---------- 2. Build prompt + call the model ----------
  const { system, user } = buildInvestigatorPrompt(request);

  let rawText: string;
  try {
    const model = getGenerativeModel();
    const result = await model.generateContent({
      systemInstruction: { role: "system", parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    });
    rawText = result.response.text();
  } catch (err) {
    throw new AnalyzeTicketError(
      `LLM call failed: ${
        err instanceof Error ? err.message : "unknown error"
      }`,
      "llm_failure"
    );
  }

  // ---------- 3. Parse + normalize the model output ----------
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

  // ---------- 4. Safety post-processing ----------
  const replyFlags = scanText("customer_reply", normalized.customer_reply);
  const actionFlags = scanText(
    "recommended_next_action",
    normalized.recommended_next_action
  );
  const allFlags = [...replyFlags, ...actionFlags];

  if (allFlags.length > 0) {
    // Always rewrite unsafe text to the strict fallback — never trust the draft.
    // Pick the localized fallback that matches the input language, so a
    // Bangla complaint stays in Bangla even after a safety rewrite.
    normalized.customer_reply = pickSafeCustomerReplyFallback(
      request.language
    );
    normalized.recommended_next_action = SAFE_NEXT_ACTION_FALLBACK;
    normalized.human_review_required = true;
  }

  // Strip the internal counter from the wire response.
  const { safetyFlags: _ignored, ...response } = normalized;
  void _ignored;

  return response;
}
