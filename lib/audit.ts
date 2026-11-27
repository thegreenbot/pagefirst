import { createHmac, randomUUID } from "node:crypto";
import { databaseConfigured, query, transaction } from "@/lib/db/client";
import { redact } from "@/lib/log";
import type { Op } from "@/lib/page/types";

/**
 * Append-only audit log (#17). Records who did what to which Doc, never the
 * Doc's text or any token. Writes go to Postgres when it is configured and
 * always to a structured JSON log line carrying the same request id.
 */

export type AuditEventName =
  | "auth.sign_in"
  | "auth.sign_out"
  | "auth.token_revoked"
  | "page.create"
  | "page.commit"
  | "page.import"
  | "page.publish"
  | "page.presentation"
  | "site.theme.update"
  | "media.upload"
  | "drive.temp_share.created"
  | "drive.temp_share.removed"
  | "api_key.created"
  | "api_key.used"
  | "api_key.revoked"
  | "job.started"
  | "job.completed"
  | "request.denied";

export type AuditEvent = {
  event: AuditEventName;
  outcome: "ok" | "denied" | "error";
  requestId?: string | null;
  actorSub?: string | null;
  actorKey?: string;
  client?: "ui" | "api" | "mcp";
  fileId?: string | null;
  baseRevisionId?: string | null;
  resultRevisionId?: string | null;
  ops?: Op[];
  status?: number;
  errorCode?: string | null;
  idempotencyKey?: string | null;
  ip?: string | null;
  siteId?: string | null;
  pagePath?: string | null;
};

export const AUDIT_RETENTION_DAYS = 400;

/** A request id from the platform or the middleware, or a new one. */
export function requestIdFrom(request: Request): string {
  const header = request.headers.get("x-request-id") || request.headers.get("x-vercel-id");
  return header && /^[\w.:-]{1,128}$/.test(header) ? header : randomUUID();
}

export function clientIp(request: Request): string | null {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || null;
}

/** IPs are stored keyed-hashed, so the log can link requests without holding addresses. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const key = process.env.TOKEN_ENCRYPTION_KEY || "pagefirst-audit";
  return createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

function opKinds(ops: Op[] | undefined): string[] | null {
  if (!ops) return null;
  return [...new Set(ops.map((op) => op.op))].sort();
}

/** Writes one audit event. Never throws: a failed write is logged, not surfaced to the user. */
export async function recordAudit(event: AuditEvent): Promise<void> {
  const row = {
    requestId: event.requestId ?? null,
    actorSub: event.actorSub ?? null,
    actorKey: event.actorKey ?? "ui",
    client: event.client ?? "ui",
    event: event.event,
    fileId: event.fileId ?? null,
    baseRevisionId: event.baseRevisionId ?? null,
    resultRevisionId: event.resultRevisionId ?? null,
    opCount: event.ops ? event.ops.length : null,
    opKinds: opKinds(event.ops),
    outcome: event.outcome,
    status: event.status ?? null,
    errorCode: event.errorCode ? redact(event.errorCode).slice(0, 200) : null,
    idempotencyKey: event.idempotencyKey ?? null,
    ipHash: hashIp(event.ip),
    siteId: event.siteId ?? null,
    pagePath: event.pagePath ? event.pagePath.slice(0, 512) : null,
  };
  console.log(JSON.stringify({ level: "info", type: "audit", ...row }));
  if (!databaseConfigured()) return;
  try {
    await query(
      `INSERT INTO audit_events (request_id, actor_sub, actor_key, client, event, file_id, base_revision_id,
         result_revision_id, op_count, op_kinds, outcome, status, error_code, idempotency_key, ip_hash, site_id, page_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        row.requestId,
        row.actorSub,
        row.actorKey,
        row.client,
        row.event,
        row.fileId,
        row.baseRevisionId,
        row.resultRevisionId,
        row.opCount,
        row.opKinds,
        row.outcome,
        row.status,
        row.errorCode,
        row.idempotencyKey,
        row.ipHash,
        row.siteId,
        row.pagePath,
      ],
    );
  } catch (error) {
    console.error(
      JSON.stringify({ level: "error", type: "audit_write_failed", requestId: row.requestId, error: redact(String(error)) }),
    );
  }
}

export type AuditRow = {
  id: string;
  at: string;
  event: string;
  outcome: string;
  status: number | null;
  file_id: string | null;
  base_revision_id: string | null;
  result_revision_id: string | null;
  op_count: number | null;
  op_kinds: string[] | null;
  client: string;
  request_id: string | null;
  error_code: string | null;
  site_id: string | null;
  page_path: string | null;
};

/** The newest events for one account, for "my activity". */
export async function auditEventsFor(sub: string, limit = 100): Promise<AuditRow[]> {
  return query<AuditRow>(
    `SELECT id::text, at, event, outcome, status, file_id, base_revision_id, result_revision_id,
            op_count, op_kinds, client, request_id, error_code, site_id, page_path
       FROM audit_events WHERE actor_sub = $1 ORDER BY at DESC, id DESC LIMIT $2`,
    [sub, Math.min(Math.max(limit, 1), 500)],
  );
}

/** Every event in a time range, for an admin export. */
export async function auditEventsBetween(from: Date, to: Date, limit = 5000): Promise<(AuditRow & { actor_sub: string | null })[]> {
  return query(
    `SELECT id::text, at, actor_sub, event, outcome, status, file_id, base_revision_id, result_revision_id,
            op_count, op_kinds, client, request_id, error_code, site_id, page_path
       FROM audit_events WHERE at >= $1 AND at < $2 ORDER BY at, id LIMIT $3`,
    [from, to, Math.min(Math.max(limit, 1), 50_000)],
  );
}

/** Retention: deletes events older than `days`. The only path allowed past the append-only trigger. */
export async function pruneAuditEvents(days = AUDIT_RETENTION_DAYS): Promise<number> {
  return transaction(async (client) => {
    await client.query("SET LOCAL pagefirst.audit_maintenance = 'on'");
    const result = await client.query("DELETE FROM audit_events WHERE at < now() - make_interval(days => $1)", [days]);
    return result.rowCount ?? 0;
  });
}

export function auditAdmins(): Set<string> {
  return new Set(
    (process.env.AUDIT_ADMIN_EMAILS ?? "")
      .split(/[\s,]+/)
      .map((email) => email.trim().toLowerCase())
      .filter((email) => email.includes("@")),
  );
}
