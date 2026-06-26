import { NextResponse } from "next/server";

import {
  analyzeTicketAction,
  AnalyzeTicketError,
} from "@/server/actions/analyzeTicket";
import type { AnalyzeTicketRequest } from "@/types/investigator";

/**
 * POST /analyze-ticket
 *
 * Accepts a single customer complaint + transaction history snippet and
 * returns a structured Investigator response per Section 6 of the problem
 * statement. The route is intentionally thin: it parses the body, delegates
 * to the server action, and maps the action's typed errors to HTTP codes.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 }
    );
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Request body must be a JSON object" },
      { status: 400 }
    );
  }

  try {
    const response = await analyzeTicketAction(body as AnalyzeTicketRequest);
    return NextResponse.json(response, { status: 200 });
  } catch (err) {
    if (err instanceof AnalyzeTicketError) {
      // Map typed orchestrator errors to the HTTP codes in Section 4.1.
      const status =
        err.code === "missing_ticket_id" || err.code === "empty_complaint"
          ? 422
          : 500;
      return NextResponse.json({ error: err.message }, { status });
    }

    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : "Unexpected internal error",
      },
      { status: 500 }
    );
  }
}