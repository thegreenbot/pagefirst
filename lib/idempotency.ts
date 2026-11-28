import { createHash } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";

/**
 * Idempotency keys for mutating API calls (#38). A client that retries after a
 * timeout sends the same `Idempotency-Key`; the first request's response is
 * replayed instead of the work running twice.
 *
 * (credential, key) -> request hash, state, response, kept 24 hours.
 *  - same key, same request, finished: the stored response
 *  - same key, different request: idempotency_mismatch (422)
 *  - same key while the first is still running: in_progress (409)
 *
 * Postgres when DATABASE_URL is set, else this process's memory (local dev and
 * preview deployments without a database).
 */

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/** A request that never finished (crashed instance) frees its key after this. */
export const IN_PROGRESS_STALE_MS = 2 * 60 * 1000;

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,255}$/;

export function validIdempotencyKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

export function hashRequest(method: string, path: string, body: string): string {
  return createHash("sha256").update(`${method}\n${path}\n${body}`).digest("hex");
}

/** A per-item key for a bulk job, so a resumed job never repeats a finished item. */
export function derivedKey(jobKey: string, itemId: string): string {
  return `${jobKey.slice(0, 120)}:${createHash("sha256").update(itemId).digest("hex").slice(0, 32)}`;
}

export type StoredResponse = { status: number; body: string };
export type Begin =
  | { state: "new" }
  | { state: "replay"; response: StoredResponse }
  | { state: "mismatch" }
  | { state: "in_progress" };

type MemoryRow = { hash: string; done: boolean; response?: StoredResponse; createdAt: number; expiresAt: number };
const holder = globalThis as typeof globalThis & { __pageFirstIdempotency?: Map<string, MemoryRow> };
const memory: Map<string, MemoryRow> = holder.__pageFirstIdempotency ?? new Map();
holder.__pageFirstIdempotency = memory;

function memoryKey(credentialId: string, key: string): string {
  return `${credentialId}\n${key}`;
}

function beginMemory(credentialId: string, key: string, hash: string, now: number): Begin {
  const id = memoryKey(credentialId, key);
  const row = memory.get(id);
  if (row && (row.expiresAt <= now || (!row.done && now - row.createdAt > IN_PROGRESS_STALE_MS))) memory.delete(id);
  const live = memory.get(id);
  if (!live) {
    memory.set(id, { hash, done: false, createdAt: now, expiresAt: now + IDEMPOTENCY_TTL_MS });
    if (memory.size > 10_000) for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
    return { state: "new" };
  }
  if (live.hash !== hash) return { state: "mismatch" };
  return live.done && live.response ? { state: "replay", response: live.response } : { state: "in_progress" };
}

async function beginPostgres(credentialId: string, key: string, hash: string): Promise<Begin> {
  await query(
    `DELETE FROM idempotency_keys
      WHERE credential_id = $1 AND key = $2
        AND (expires_at < now() OR (state = 'in_progress' AND created_at < now() - make_interval(secs => $3)))`,
    [credentialId, key, IN_PROGRESS_STALE_MS / 1000],
  );
  const inserted = await query(
    `INSERT INTO idempotency_keys (credential_id, key, request_hash, state) VALUES ($1, $2, $3, 'in_progress')
     ON CONFLICT DO NOTHING RETURNING 1`,
    [credentialId, key, hash],
  );
  if (inserted.length > 0) {
    if (Math.random() < 0.01) void query("DELETE FROM idempotency_keys WHERE expires_at < now()").catch(() => undefined);
    return { state: "new" };
  }
  const [row] = await query<{ request_hash: string; state: string; response_status: number | null; response_body: string | null }>(
    "SELECT request_hash, state, response_status, response_body FROM idempotency_keys WHERE credential_id = $1 AND key = $2",
    [credentialId, key],
  );
  // The row vanished between the insert and the read (expiry sweep): treat as in progress so the client retries.
  if (!row) return { state: "in_progress" };
  if (row.request_hash !== hash) return { state: "mismatch" };
  if (row.state === "done" && row.response_status !== null) {
    return { state: "replay", response: { status: row.response_status, body: row.response_body ?? "" } };
  }
  return { state: "in_progress" };
}

export async function beginIdempotent(credentialId: string, key: string, hash: string, now = Date.now()): Promise<Begin> {
  return databaseConfigured() ? beginPostgres(credentialId, key, hash) : beginMemory(credentialId, key, hash, now);
}

/** Responses worth replaying. A 429 or 5xx says nothing about the work, so the key is freed and a retry runs it. */
export function shouldStore(status: number): boolean {
  return status < 500 && status !== 429 && status !== 408;
}

export async function finishIdempotent(credentialId: string, key: string, response: StoredResponse): Promise<void> {
  if (!shouldStore(response.status)) return releaseIdempotent(credentialId, key);
  if (!databaseConfigured()) {
    const row = memory.get(memoryKey(credentialId, key));
    if (row) {
      row.done = true;
      row.response = response;
    }
    return;
  }
  await query(
    "UPDATE idempotency_keys SET state = 'done', response_status = $3, response_body = $4 WHERE credential_id = $1 AND key = $2",
    [credentialId, key, response.status, response.body],
  );
}

/** Frees the key without a stored response. */
export async function releaseIdempotent(credentialId: string, key: string): Promise<void> {
  if (!databaseConfigured()) {
    memory.delete(memoryKey(credentialId, key));
    return;
  }
  await query("DELETE FROM idempotency_keys WHERE credential_id = $1 AND key = $2", [credentialId, key]);
}
