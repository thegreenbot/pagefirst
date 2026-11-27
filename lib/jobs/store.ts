import { randomBytes } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { MAX_CONCURRENT_JOBS_PER_CREDENTIAL, MAX_PAGES_PER_JOB } from "@/lib/api/limits";
import { ServiceError, type Scope } from "@/lib/service";

/**
 * Persistence for bulk jobs (#40). All progress is rows, so a job survives a
 * restart: whatever process picks it up next continues from the item table.
 */

export const JOB_KINDS = ["commit", "publish", "import", "import_and_publish"] as const;
export type JobKind = (typeof JOB_KINDS)[number];
export type JobStatus = "queued" | "running" | "done" | "cancelled";
export type ItemStatus = "pending" | "running" | "ok" | "skipped" | "conflict" | "error" | "cancelled";

/** An item left "running" this long was abandoned by a process that died; it goes back to pending. */
export const STALE_ITEM_MS = 5 * 60 * 1000;

export type JobRow = {
  id: string;
  credentialId: string;
  sub: string;
  scopes: Scope[];
  siteFolders: string[] | null;
  kind: JobKind;
  status: JobStatus;
  dryRun: boolean;
  policy: Record<string, unknown>;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type JobItem = {
  idx: number;
  fileId: string;
  params: Record<string, unknown>;
  status: ItemStatus;
  code: string | null;
  message: string | null;
  result: unknown;
  attempts: number;
};

export type NewItem = { fileId: string; params: Record<string, unknown> };

type Row = {
  id: string;
  credential_id: string;
  sub: string;
  scopes: string[];
  site_folders: string[] | null;
  kind: JobKind;
  status: JobStatus;
  dry_run: boolean;
  policy: Record<string, unknown>;
  cancel_requested: boolean;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

function toJob(row: Row): JobRow {
  return {
    id: row.id,
    credentialId: row.credential_id,
    sub: row.sub,
    scopes: row.scopes as Scope[],
    siteFolders: row.site_folders,
    kind: row.kind,
    status: row.status,
    dryRun: row.dry_run,
    policy: row.policy,
    cancelRequested: row.cancel_requested,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export type NewJob = {
  credentialId: string;
  sub: string;
  scopes: readonly Scope[];
  siteFolders?: readonly string[];
  kind: JobKind;
  dryRun: boolean;
  policy: Record<string, unknown>;
  items: NewItem[];
};

/** Accepts a job: refuses one over the item ceiling, or when the credential already has its share running. */
export async function createJob(input: NewJob): Promise<JobRow> {
  if (input.items.length === 0) throw new ServiceError("invalid", "items must have at least one entry.");
  if (input.items.length > MAX_PAGES_PER_JOB) {
    throw new ServiceError("invalid", `A job takes at most ${MAX_PAGES_PER_JOB} items.`);
  }
  const id = `job_${randomBytes(12).toString("base64url")}`;
  return transaction(async (client) => {
    // Serialize accepts per credential so two requests can't both slip under the limit.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`jobs:${input.credentialId}`]);
    const active = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM jobs WHERE credential_id = $1 AND status IN ('queued', 'running')",
      [input.credentialId],
    );
    if (Number(active.rows[0]!.n) >= MAX_CONCURRENT_JOBS_PER_CREDENTIAL) {
      throw new ServiceError("rate_limited", `At most ${MAX_CONCURRENT_JOBS_PER_CREDENTIAL} jobs can run at once for one credential.`, { retryAfterSeconds: 30 });
    }
    const { rows } = await client.query<Row>(
      `INSERT INTO jobs (id, credential_id, sub, scopes, site_folders, kind, dry_run, policy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, input.credentialId, input.sub, [...input.scopes], input.siteFolders ? [...input.siteFolders] : null, input.kind, input.dryRun, JSON.stringify(input.policy)],
    );
    // One statement for all items, so a 500-page job is not 500 round trips.
    await client.query(
      `INSERT INTO job_items (job_id, idx, file_id, params)
       SELECT $1, t.idx - 1, t.file_id, t.params::jsonb
         FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(file_id, params, idx)`,
      [id, input.items.map((item) => item.fileId), input.items.map((item) => JSON.stringify(item.params))],
    );
    return toJob(rows[0]!);
  });
}

/** A job the credential owns, or null. Another credential's job is indistinguishable from a missing one. */
export async function getJob(id: string, credentialId: string): Promise<JobRow | null> {
  const rows = await query<Row>("SELECT * FROM jobs WHERE id = $1 AND credential_id = $2", [id, credentialId]);
  return rows[0] ? toJob(rows[0]) : null;
}

export type JobCounts = Record<ItemStatus, number> & { total: number };

export async function jobCounts(id: string): Promise<JobCounts> {
  const rows = await query<{ status: ItemStatus; n: string }>("SELECT status, count(*) AS n FROM job_items WHERE job_id = $1 GROUP BY status", [id]);
  const counts: JobCounts = { pending: 0, running: 0, ok: 0, skipped: 0, conflict: 0, error: 0, cancelled: 0, total: 0 };
  for (const row of rows) {
    counts[row.status] = Number(row.n);
    counts.total += Number(row.n);
  }
  return counts;
}

export async function listItems(id: string, after = -1, limit = 100): Promise<JobItem[]> {
  const rows = await query<{ idx: number; file_id: string; params: Record<string, unknown>; status: ItemStatus; code: string | null; message: string | null; result: unknown; attempts: number }>(
    "SELECT idx, file_id, params, status, code, message, result, attempts FROM job_items WHERE job_id = $1 AND idx > $2 ORDER BY idx LIMIT $3",
    [id, after, Math.min(Math.max(limit, 1), 500)],
  );
  return rows.map((row) => ({ idx: row.idx, fileId: row.file_id, params: row.params, status: row.status, code: row.code, message: row.message, result: row.result, attempts: row.attempts }));
}

/**
 * Takes up to `n` pending items for this process. SKIP LOCKED lets two
 * processes advance the same job without ever taking the same item. Items an
 * earlier process abandoned while "running" are returned to pending first.
 */
export async function claimItems(jobId: string, n: number, now = new Date()): Promise<JobItem[]> {
  return transaction(async (client) => {
    await client.query(
      "UPDATE job_items SET status = 'pending' WHERE job_id = $1 AND status = 'running' AND started_at < $2",
      [jobId, new Date(now.getTime() - STALE_ITEM_MS)],
    );
    const { rows } = await client.query<{ idx: number; file_id: string; params: Record<string, unknown>; attempts: number }>(
      `UPDATE job_items SET status = 'running', started_at = $3, attempts = attempts + 1
        WHERE (job_id, idx) IN (
          SELECT job_id, idx FROM job_items WHERE job_id = $1 AND status = 'pending'
           ORDER BY idx LIMIT $2 FOR UPDATE SKIP LOCKED)
        RETURNING idx, file_id, params, attempts`,
      [jobId, n, now],
    );
    await client.query("UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, $2) WHERE id = $1 AND status = 'queued'", [jobId, now]);
    return rows
      .sort((a, b) => a.idx - b.idx)
      .map((row) => ({ idx: row.idx, fileId: row.file_id, params: row.params, status: "running" as const, code: null, message: null, result: null, attempts: row.attempts }));
  });
}

export async function finishItem(jobId: string, idx: number, status: Exclude<ItemStatus, "pending" | "running">, detail: { code?: string; message?: string; result?: unknown } = {}): Promise<void> {
  await query(
    "UPDATE job_items SET status = $3, code = $4, message = $5, result = $6, finished_at = now() WHERE job_id = $1 AND idx = $2",
    [jobId, idx, status, detail.code ?? null, detail.message?.slice(0, 500) ?? null, detail.result === undefined ? null : JSON.stringify(detail.result)],
  );
}

/** Marks the job done (or cancelled) when no item is left to run. Returns the final status, or null if work remains. */
export async function settleJob(jobId: string): Promise<JobStatus | null> {
  const job = await query<{ cancel_requested: boolean }>("SELECT cancel_requested FROM jobs WHERE id = $1", [jobId]);
  if (job[0]?.cancel_requested) {
    await query("UPDATE job_items SET status = 'cancelled', finished_at = now() WHERE job_id = $1 AND status = 'pending'", [jobId]);
  }
  const left = await query<{ n: string }>("SELECT count(*) AS n FROM job_items WHERE job_id = $1 AND status IN ('pending', 'running')", [jobId]);
  if (Number(left[0]!.n) > 0) return null;
  const status: JobStatus = job[0]?.cancel_requested ? "cancelled" : "done";
  await query("UPDATE jobs SET status = $2, finished_at = now() WHERE id = $1 AND status IN ('queued', 'running')", [jobId, status]);
  return status;
}

/** Stops handing out new items; items already running finish. */
export async function requestCancel(id: string, credentialId: string): Promise<JobRow | null> {
  await query("UPDATE jobs SET cancel_requested = true WHERE id = $1 AND credential_id = $2 AND status IN ('queued', 'running')", [id, credentialId]);
  const job = await getJob(id, credentialId);
  if (job) await settleJob(id);
  return job ? getJob(id, credentialId) : null;
}

/**
 * Re-queues the items that did not finish (error, conflict, cancelled) and
 * reopens the job. Finished items are never run again.
 */
export async function resumeJob(id: string, credentialId: string): Promise<JobRow | null> {
  const job = await getJob(id, credentialId);
  if (!job) return null;
  if (job.status === "running" || job.status === "queued") return job;
  const active = await query<{ n: string }>("SELECT count(*) AS n FROM jobs WHERE credential_id = $1 AND status IN ('queued', 'running')", [credentialId]);
  if (Number(active[0]!.n) >= MAX_CONCURRENT_JOBS_PER_CREDENTIAL) {
    throw new ServiceError("rate_limited", `At most ${MAX_CONCURRENT_JOBS_PER_CREDENTIAL} jobs can run at once for one credential.`, { retryAfterSeconds: 30 });
  }
  await transaction(async (client) => {
    await client.query("UPDATE job_items SET status = 'pending', code = NULL, message = NULL, result = NULL, finished_at = NULL WHERE job_id = $1 AND status IN ('error', 'conflict', 'cancelled')", [id]);
    await client.query("UPDATE jobs SET status = 'queued', cancel_requested = false, finished_at = NULL WHERE id = $1", [id]);
  });
  return getJob(id, credentialId);
}

/** Jobs with work left, for a process that restarted and wants to continue them. */
export async function unfinishedJobIds(limit = 20): Promise<string[]> {
  const rows = await query<{ id: string }>("SELECT id FROM jobs WHERE status IN ('queued', 'running') ORDER BY created_at LIMIT $1", [limit]);
  return rows.map((row) => row.id);
}

/** Puts a claimed item back to pending, for a transient failure worth retrying later. */
export async function releaseItem(jobId: string, idx: number): Promise<void> {
  await query("UPDATE job_items SET status = 'pending', started_at = NULL WHERE job_id = $1 AND idx = $2 AND status = 'running'", [jobId, idx]);
}

export async function readJobById(id: string): Promise<JobRow | null> {
  const rows = await query<Row>("SELECT * FROM jobs WHERE id = $1", [id]);
  return rows[0] ? toJob(rows[0]) : null;
}
