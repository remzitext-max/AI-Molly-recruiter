# Molly Recruiting Assistant

A server-hosted web app where an AI assistant makes the first recruiting call to truck-driver leads on behalf of Molly, collects screening answers, explains approved offer facts, requests a CDL through a secure link, and hands interested drivers to a human recruiter. Recruiters use it from any browser; it keeps running on the server when their computers are off.

**A handoff is never a hire.** The human recruiter / Safety team does all official verification, approval and onboarding.

## Status at a glance

| Area | State |
|---|---|
| Dashboard, accounts, roles, assignment, import, knowledge base, contact controls, CDL upload, handoff | Working |
| Simulated calls with 11 synthetic driver personas | Working (demo mode) |
| Retell voice-agent adapter, webhooks, restricted tool endpoint | Built from docs, **not yet tested on a live account** |
| RingCentral SMS + recruiter click-to-call (RingOut) | Built from docs, **not yet tested on a live account** |
| RingCentral as the AI call audio path | **Blocked**: no public SIP trunk (see docs/INTEGRATIONS.md) |
| Molly's cloned voice | **Not created**. Recording not supplied; HeyGen voices cannot be used on phone calls (docs/VOICE.md) |
| Google Sheets lead sync (reviewed first import, automatic new-row sync, optional status write-back) | Working with a demo sheet; real-sheet path built from Google docs, **not yet tested on your sheet** |

Details: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md), [docs/VOICE.md](docs/VOICE.md), [docs/PRODUCTION-CHECKLIST.md](docs/PRODUCTION-CHECKLIST.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md).

## Quick start (local demo)

### Option A: Docker Compose

```bash
cp .env.example .env              # set SESSION_SECRET to a long random string
docker compose up --build
# open http://localhost:3000  (admin@demo.local / demo-admin-pass)
```

The `migrate` service applies migrations and seeds a demo organization, an admin, two recruiters (Molly and Alex demo accounts), a synthetic offer and a demo campaign.

### Option B: Node + your own Postgres

Requirements: Node 22, PostgreSQL 14+.

```bash
npm ci
cp .env.example .env              # set DATABASE_URL and SESSION_SECRET
npx prisma migrate deploy
npm run db:seed
npm run build && npm start        # web on :3000
npm run worker                    # background worker (separate terminal)
```

### Try the demo

1. Sign in as `admin@demo.local` / `demo-admin-pass`.
2. Dashboard → **Load synthetic demo leads**. Twelve fictional drivers are created; the worker places simulated calls (interested driver, unknown questions, opt-out, busy/callback, wants a human, failed transfer, voicemail, no answer, eligibility issue, prompt-injection attempt, missing permission, unknown timezone).
3. Open **Marcus Demo-Reed**: read the transcript, screening answers (driver-reported vs verified), the offer version discussed, and the simulated text. Click the upload link in the "Simulated driver phone" box, upload any JPG/PNG/PDF, and the candidate moves to **handed off** with a task for Molly.
4. Sign in as `molly@demo.local` / `demo-recruiter-pass` to see the recruiter view (only assigned candidates).
5. **Voice** page: generate placeholder previews and try the conversation in the text sandbox.

Demo data is labelled everywhere (purple **demo / simulated / mock** badges). Demo records can never be dialed by a live provider, and live records are never touched by the simulator.

## Checks

```bash
createdb molly_test                 # or set TEST_DATABASE_URL
npm test                            # 45 tests, including all 14 acceptance checks
npm run typecheck
```

## Architecture

- **Next.js 15 (App Router, TypeScript)**: dashboard, server actions, API routes, webhooks. Every page/action checks the session and role server-side; recruiters are scoped to assigned candidates in the query itself (`src/lib/rbac.ts`).
- **PostgreSQL + Prisma**: schema in `prisma/schema.prisma`. Pipeline status, call-attempt status, document status and contact permission are separate fields/tables.
- **Durable job queue in Postgres** (`src/lib/jobs/queue.ts`): `FOR UPDATE SKIP LOCKED`, retries with backoff, dead-letter + "retry safely", abandoned locks reclaimed after restarts. Worker: `worker/index.ts`.
- **Call engine** (`src/lib/calls.ts`): contact gate before every call/text, per-lead call lock (unique `activeAttemptId`), idempotent and out-of-order-safe provider events, reconciliation of uncertain outcomes, transfers confirmed only by provider events.
- **Agent rules** (`src/lib/conversation/brain.ts`): deterministic brain for demo/tests; the same rules are given to the live provider as a prompt plus a closed tool set (`src/lib/agent-config.ts`, `/api/agent/tools`). Agent output can only change data through `applyAgentAction`'s closed schema.
- **Adapters** (`src/adapters`): lead source, voice agent, telephony, SMS, document storage, document extraction, voice synthesis. Mock implementations for demo; live ones refuse to act without credentials.
