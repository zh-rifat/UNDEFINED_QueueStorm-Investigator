# QueueStorm Investigator

AI/API support copilot for the **bKash presents SUST CSE Carnival 2026 — Codex
Community Hackathon** (Preliminary Round).

The service exposes two HTTP endpoints:

| Method | Path                  | Purpose                                                       |
| ------ | --------------------- | ------------------------------------------------------------- |
| GET    | `/api/health`         | Liveness probe; returns `{"status":"ok"}`.                    |
| POST   | `/api/analyze-ticket` | Classify, route, and draft a safe reply for one support case. |

**Live demo:** <https://undefined-queue-storm-investigator.vercel.app/>

- Health probe: <https://undefined-queue-storm-investigator.vercel.app/api/health>
- Analyze endpoint: `POST https://undefined-queue-storm-investigator.vercel.app/api/analyze-ticket`


---

## Setup

Requirements: **Node.js 20+**, an internet-reachable host, and a Google Gemini
API key.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables
cp .env.example .env
# then edit .env and set GEMINI_API_KEY

# 3. Run in development
npm run dev
# → http://localhost:3000/api/health
# → http://localhost:3000/api/analyze-ticket

# 4. Production build (Next.js standalone server)
npm run build
npm run start
```

### Environment variables

| Variable        | Required | Default              | Notes                                  |
| --------------- | -------- | -------------------- | -------------------------------------- |
| `LLM_PROVIDER`   | no       | `gemini`             | `gemini` (default, multi-key rotation) or `openrouter`. Aliases: `google`, `google-gemini` → `gemini`; `or` → `openrouter`. |
| `GEMINI_API_KEY` | yes (when `LLM_PROVIDER=gemini`) | —   | Comma-separated list of Google AI Studio keys. The client round-robins through them and falls back to the next key on 429. |
| `GEMINI_MODEL`   | no       | `gemini-2.5-flash`   | Override to a different Gemini model.  |
| `GEMINI_KEY_COOLDOWN_MS` | no | `60000`              | How long a rate-limited key stays out of rotation (ms). |
| `OPENROUTER_API_KEY` | yes (when `LLM_PROVIDER=openrouter`) | — | Single OpenRouter key. No rotation. |
| `OPENROUTER_MODEL` | no    | `google/gemini-2.5-flash` | Override to any OpenRouter model id. |

### Gemini key pool rotation

When `LLM_PROVIDER=gemini` (the default), the client treats `GEMINI_API_KEY` as
a **pool** rather than a single credential:

1. **Parsing.** `GEMINI_API_KEY` is split on commas; each entry is trimmed,
   blanks are dropped, and duplicates are removed while preserving the
   first-seen order.
2. **Round-robin.** A module-scoped cursor (`lastKeyIndex`) walks the pool on
   every call, so consecutive requests spread across keys instead of hammering
   the first one.
3. **Rate-limit detection.** On HTTP 429, `RESOURCE_EXHAUSTED`, or a
   quota-shaped message, the offending key is marked cooling-down for
   `GEMINI_KEY_COOLDOWN_MS` (default 60s, capped at 10 min) and the loop
   advances to the next non-cooling-down key.
4. **Bounded retries.** The retry loop is bounded by `keyPool.length`, so a
   poisoned key can never spin forever — once every key has been tried,
   the client throws a typed `GeminiRateLimitError` which the orchestrator
   surfaces as `llm_failure`.

Concrete example: with three keys configured and key #2 hitting 429, the
client serves the next request from key #3, and key #2 re-enters the rotation
once its cooldown expires.

---

## API

### `POST /api/analyze-ticket`

Request body (the `transaction_history` array is optional and may be empty for
pure safety cases):

```json
{
  "ticket_id": "TKT-001",
  "complaint": "I sent 5000 taka to a wrong number around 2pm today...",
  "language": "en",
  "channel": "in_app_chat",
  "user_type": "customer",
  "campaign_context": "boishakh_bonanza_day_1",
  "transaction_history": [
    {
      "transaction_id": "TXN-9101",
      "timestamp": "2026-04-14T14:08:22Z",
      "type": "transfer",
      "amount": 5000,
      "counterparty": "+8801719876543",
      "status": "completed"
    }
  ]
}
```

Response body always matches this schema and always returns HTTP `200` when the
service can analyze the input. Malformed JSON returns `400`; semantically
empty complaints return `422`; catastrophic internal failures return `500`.

```json
{
  "ticket_id": "TKT-001",
  "relevant_transaction_id": "TXN-9101",
  "evidence_verdict": "consistent",
  "case_type": "wrong_transfer",
  "severity": "high",
  "department": "dispute_resolution",
  "agent_summary": "Customer reports sending 5000 BDT via TXN-9101 to an unintended recipient.",
  "recommended_next_action": "Verify TXN-9101 details with the customer and escalate to dispute resolution.",
  "customer_reply": "We have noted your concern about transaction TXN-9101. Our support team will review the case and follow up through our official channels.",
  "human_review_required": true,
  "confidence": 0.88,
  "reason_codes": ["wrong_transfer", "transaction_match"]
}
```

### `GET /api/health`

```json
{ "status": "ok" }
```

---

## MODELS

| Model              | Where it runs | Why chosen                                                                                            |
| ------------------ | ------------- | ----------------------------------------------------------------------------------------------------- |
| `gemini-2.5-flash` | Google AI     | Low-latency, low-cost; well-suited for a 30-second per-request SLA and a 60-second readiness window.   |

The model is called with `responseMimeType: "application/json"`, `temperature:
0.2`, and `maxOutputTokens: 1024`. Every prompt asks for a single JSON object
that mirrors the published response schema exactly.

---

## AI approach

1. **Single-pass reasoning inside the prompt.** The model is asked to reason
   step-by-step internally, then emit one JSON object that already classifies,
   routes, and drafts the customer reply. A two-pass design was considered but
   rejected because of the 30-second per-request budget.
2. **Deterministic parsing.** The parser (`features/investigator/parser.ts`)
   falls back through three strategies — direct parse, markdown-fence strip,
   first `{...}` extraction — so transient formatting drift from the model
   never breaks the contract.
3. **Strict enum coercion.** Enum fields are coerced into the allowed set from
   the problem statement. Unknown values fall back to safe defaults
   (`case_type="other"`, `department="customer_support"`,
   `evidence_verdict="insufficient_data"`) so the schema never invalidates.
4. **Safety post-processing.** Every draft is scanned for credential requests,
   unauthorized refund confirmations, and suspicious third-party referrals. Any
   hit rewrites the customer reply and the next-action text to a strict
   fallback and forces `human_review_required: true`.
5. **Prompt-injection defense.** The complaint is treated as untrusted text;
   the system prompt instructs the model to ignore instructions embedded in
   the customer message.

---

## Safety logic (Section 8)

The judge harness scores these rules automatically. The implementation:

- **Never requests credentials.** Regex scan rejects any draft that mentions
  PIN, OTP, password, CVV, or full card numbers.
- **Never confirms refunds or reversals.** Phrases like "we will refund",
  "refund has been processed", or "we will reverse the transaction" cause the
  reply to be replaced with a fallback that only references "official
  channels".
- **Never refers customers to suspicious third parties.** Drafts that direct
  the customer to contact "the recipient", "the merchant", or to share a code
  with a counterparty are rewritten. Referring customers to the in-app help
  center or the official hotline is allowed.
- **Ignores prompt injection.** Instructions embedded in the complaint cannot
  override the system prompt or safety rules.

---

## Architecture

The codebase follows the layered architecture described in `.ai-agent/architecture.md`,
adapted to an API surface rather than a portfolio page:

```
src/
├── app/
│   ├── api/
│   │   ├── health/route.ts          # GET /api/health
│   │   └── analyze-ticket/route.ts  # POST /api/analyze-ticket
│   ├── layout.tsx
│   └── page.tsx                     # Landing page (links to both endpoints)
├── server/                          # Server-only modules
│   ├── llm/                         # LLM provider clients + selector (OpenRouter / Gemini)
│   └── actions/
│       └── analyzeTicket.ts         # Orchestrator action
├── features/
│   └── investigator/
│       ├── prompt.ts                # System + user prompt builder
│       ├── parser.ts                # JSON parsing + enum coercion
│       └── safety.ts                # Safety rule scanner + safe fallbacks
└── types/
    └── investigator.ts              # Request/response DTOs + enums
```

Per the architecture rule, Prisma / DB access lives only inside `server/`
modules — there is no database here, but the boundary is preserved so the
shape scales to a future persistence layer.

---

## Assumptions and known limitations

- The service trusts Google's Gemini API to be reachable from the deployment
  region. Latency depends on Google AI Studio uptime and quotas.
- The 10 published sample cases are used as a smoke-test set, not as the
  evaluation target. Hidden cases include multilingual, ambiguous, and
  safety-sensitive inputs and are not visible in the repository.
- Confidence is reported as a heuristic and is not calibrated against a
  labelled dataset.

---

## Deployment

The service is a standard Next.js 16 app. Any platform that runs Node 20+
will work — Vercel, Render, Railway, Fly, AWS EC2, or a Poridhi Labs
`t3.medium`. To deploy on Vercel:

```bash
vercel --prod
# then set GEMINI_API_KEY in the Vercel dashboard
```

For Docker, a minimal `Dockerfile` based on `node:20-alpine` with
`npm run build && npm run start` is sufficient. The image is well under the
preferred 5 GB limit because no model weights are baked in.

---

## Testing the service locally

```bash
# Health check
curl http://localhost:3000/api/health

# Sample case
curl -X POST http://localhost:3000/api/analyze-ticket \
  -H "Content-Type: application/json" \
  -d '{
    "ticket_id": "TKT-001",
    "complaint": "I sent 5000 taka to a wrong number around 2pm today. Please refund.",
    "language": "en",
    "transaction_history": [
      {
        "transaction_id": "TXN-9101",
        "timestamp": "2026-04-14T14:08:22Z",
        "type": "transfer",
        "amount": 5000,
        "counterparty": "+8801719876543",
        "status": "completed"
      }
    ]
  }'
```
