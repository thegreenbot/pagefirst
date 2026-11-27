# ADR 0001: Persistent store

- Status: accepted
- Date: 2026-11-27
- Decided by: Will (issue #10)

## Context

PLAN.md said "no database until unattended publish". The roadmap now needs durable state shared across app instances:

- server-side sessions and encrypted Google refresh tokens (#16)
- the append-only audit log (#17)
- rate-limit counters, media and previews shared across instances (#18)
- revision snapshots, idempotency keys and job state (import, API)
- each site's theme config and publish target (#56, #94)

The app runs on Vercel as a Next.js app. Publishing goes to Cloudflare.

## Options considered

Monthly cost estimates from published pricing on 2026-11-27, at roughly 10, 500 and 10,000 users:

| Option | ~10 | ~500 | ~10,000 | Notes |
| --- | --- | --- | --- | --- |
| Neon Postgres + Upstash Redis | $0 | $25–45 | $110–200 | Works from Vercel; Postgres features (triggers, roles, JSONB) |
| Supabase Pro + Upstash | $0–25 | $25–35 | $60–110+ | Free tier pauses after a week idle |
| Cloudflare D1 + KV | $5 | $5–10 | $40–90 | Only usable from Workers, so the app would have to move; SQLite has no roles or triggers that stop an owner from deleting audit rows |

## Decision

- **Neon Postgres** is the system of record. The app connects with `DATABASE_URL` (Neon's pooled connection string) through `pg` in Node route handlers (`lib/db/client.ts`).
- **Upstash Redis** holds short-lived counters (rate limits), reached over its REST API with `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
- Both are provisioned through the Vercel Marketplace, so credentials exist only in Vercel's environment for Production and Preview. Nothing is committed.
- Region: the Neon and Upstash region closest to the Vercel functions' region (US by default). Data residency beyond that is out of scope until a customer needs it.

### Schema changes

Migrations live in `lib/db/migrations.ts` as an ordered list. The app applies pending ones on first database use, under a Postgres advisory lock so concurrent instances never run them twice. Shipped migrations are never edited.

### Encryption at rest

Neon encrypts storage at rest. On top of that, refresh tokens are encrypted by the app with AES-256-GCM under `TOKEN_ENCRYPTION_KEY` (32 random bytes, a Vercel sensitive variable), so a database dump alone does not expose them. Each ciphertext records a key id; rotation adds a new key, re-encrypts on next use, and retires the old one (see `runbooks/secret-rotation.md`). Moving the key into a cloud KMS is a later step if a customer requires it.

### Append-only audit

The audit table has a trigger that rejects `UPDATE` and `DELETE`, so application code cannot change history even though it connects as the table owner. Retention deletes run as a separate, documented maintenance job that disables the trigger in a transaction.

### Retention

| Data | Kept for |
| --- | --- |
| Sessions | Until sign-out, 7 days idle, or 30 days absolute |
| Refresh tokens | Until disconnect or revoke |
| Audit events | 400 days |
| Revision snapshots | Last 20 per Doc |
| Idempotency keys | 24 hours |
| Rate-limit counters | Their window (Redis TTL) |

## Consequences

- Without `DATABASE_URL` the app keeps working as before: cookie sessions, in-process limits, no audit. Features that need the store say so instead of failing.
- CI runs the database tests against a Postgres 16 service container (`TEST_DATABASE_URL`).
- Cost is about $0 now and stays under $50 a month up to a few hundred users.
