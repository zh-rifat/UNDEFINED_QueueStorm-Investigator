import "server-only";

import {
  runAnalyzeTicketCore,
  AnalyzeTicketError,
} from "@/server/actions/analyzeTicketCore";
import type {
  AnalyzeTicketRequest,
  AnalyzeTicketResponse,
} from "@/types/investigator";

/**
 * Server action wrapper around `runAnalyzeTicketCore`.
 *
 * The `server-only` guard ensures this entry point is only callable from
 * Next.js request handlers. Node-only callers (test runners, scripts) should
 * import `runAnalyzeTicketCore` directly.
 */

export { AnalyzeTicketError };

export async function analyzeTicketAction(
  request: AnalyzeTicketRequest
): Promise<AnalyzeTicketResponse> {
  return runAnalyzeTicketCore(request);
}
