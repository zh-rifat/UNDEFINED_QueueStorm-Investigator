import { NextResponse } from "next/server";

/**
 * GET /health
 *
 * Liveness probe used by the judge harness to confirm the service is ready
 * before sending traffic (Section 4 of the problem statement). Must return
 * `{"status":"ok"}` within 60 seconds of service start.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}