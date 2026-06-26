/**
 * Landing page for the Investigator service.
 *
 * The judge harness hits /api/health and /api/analyze-ticket directly. This
 * page exists so a human can `npm run dev`, open the browser, and confirm
 * both endpoints are reachable.
 */
export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6 py-16">
      <div className="max-w-2xl w-full space-y-6 font-mono text-sm">
        <h1 className="text-2xl font-semibold">QueueStorm Investigator</h1>
        <p className="text-zinc-400">
          AI/API support copilot. POST a ticket and a recent transaction
          history snippet to <code>/api/analyze-ticket</code>; the service
          returns a structured classification, routing, and safe reply.
        </p>
        <ul className="space-y-2">
          <li>
            <span className="text-zinc-500">GET&nbsp;&nbsp;</span>
            <a className="underline" href="/api/health">
              /api/health
            </a>
            <span className="text-zinc-500">
              &nbsp;— liveness probe used by the judge harness.
            </span>
          </li>
          <li>
            <span className="text-zinc-500">POST&nbsp;</span>
            <a className="underline" href="/api/analyze-ticket">
              /api/analyze-ticket
            </a>
            <span className="text-zinc-500">
              &nbsp;— accepts one ticket, returns the Investigator response.
            </span>
          </li>
        </ul>
        <p className="text-zinc-500">
          See the project README for the request/response schema and run
          instructions.
        </p>
      </div>
    </main>
  );
}
