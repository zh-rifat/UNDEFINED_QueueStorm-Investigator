import "server-only";

import {
  runAnalyzeTicketCore,
  AnalyzeTicketError,
} from "@/server/actions/analyzeTicketCore";
import type {
  AnalyzeTicketRequest,
  AnalyzeTicketResponse,
} from "@/types/investigator";


export { AnalyzeTicketError };

export async function analyzeTicketAction(
  request: AnalyzeTicketRequest
): Promise<AnalyzeTicketResponse> {
  return runAnalyzeTicketCore(request);
}
