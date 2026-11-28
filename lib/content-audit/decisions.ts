import { query } from "@/lib/db/client";

/** Per-page history of audit decisions (#50). Append-only: a new decision never replaces an old one. */

export const FINDINGS = ["stale", "expired", "thin", "duplicate"] as const;
export const DECISIONS = ["keep", "update", "merge", "rewrite", "noindex", "remove"] as const;
export type FindingKind = (typeof FINDINGS)[number];
export type DecisionKind = (typeof DECISIONS)[number];

export type AuditDecision = {
  id: string;
  fileId: string;
  actorSub: string | null;
  finding: FindingKind;
  decision: DecisionKind;
  note: string;
  revisionId: string | null;
  createdAt: string;
};

type Row = { id: string; file_id: string; actor_sub: string | null; finding: FindingKind; decision: DecisionKind; note: string; revision_id: string | null; created_at: Date };
const toDecision = (r: Row): AuditDecision => ({
  id: r.id, fileId: r.file_id, actorSub: r.actor_sub, finding: r.finding, decision: r.decision, note: r.note, revisionId: r.revision_id, createdAt: r.created_at.toISOString(),
});

export const isFinding = (v: unknown): v is FindingKind => (FINDINGS as readonly unknown[]).includes(v);
export const isDecision = (v: unknown): v is DecisionKind => (DECISIONS as readonly unknown[]).includes(v);

export async function recordDecision(input: {
  fileId: string;
  actorSub: string | null;
  finding: FindingKind;
  decision: DecisionKind;
  note?: string;
  revisionId?: string | null;
}): Promise<AuditDecision> {
  const rows = await query<Row>(
    `INSERT INTO content_audit_decisions (file_id, actor_sub, finding, decision, note, revision_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id::text, file_id, actor_sub, finding, decision, note, revision_id, created_at`,
    [input.fileId, input.actorSub, input.finding, input.decision, (input.note ?? "").slice(0, 1000), input.revisionId ?? null],
  );
  return toDecision(rows[0]!);
}

/** Newest first. */
export async function decisionsFor(fileId: string, limit = 50): Promise<AuditDecision[]> {
  const rows = await query<Row>(
    `SELECT id::text, file_id, actor_sub, finding, decision, note, revision_id, created_at
       FROM content_audit_decisions WHERE file_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
    [fileId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows.map(toDecision);
}
