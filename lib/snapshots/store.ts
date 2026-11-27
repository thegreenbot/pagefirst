import { createHash } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";
import type { Page } from "@/lib/page/types";

/**
 * Revision snapshots (#29, docs/adr/0006-import-model.md): the parsed page as it
 * stood after each commit, public publish and import. The newest one is the
 * base an import diffs the Doc against; the newest `publish` one is "what is
 * live". Recording is best effort and never fails the call that triggered it.
 */

export type SnapshotSource = "commit" | "publish" | "import";

export type Snapshot = {
  id: string;
  fileId: string;
  revisionId: string;
  source: SnapshotSource;
  actorSub: string | null;
  contentHash: string;
  /** The import this snapshot came from or was published from, if any (#34). */
  importId: string | null;
  /** The Doc's Drive modified time when this was taken, if known. */
  docModifiedTime: string | null;
  modifiedBy: string | null;
  createdAt: string;
  page: Page;
};

/** How many snapshots a Doc keeps, besides its newest published one (docs/adr/0001-persistent-store.md). */
export const SNAPSHOTS_PER_DOC = 20;

/** Hash of what a reader would see: metadata, sections and nodes, not the revision or file id. */
export function contentHash(page: Page): string {
  const sorted = Object.fromEntries(Object.entries(page.metadata).sort(([a], [b]) => (a < b ? -1 : 1)));
  return createHash("sha256").update(JSON.stringify({ path: page.path, metadata: sorted, sections: page.sections })).digest("hex");
}

type Row = {
  id: string;
  file_id: string;
  revision_id: string;
  source: SnapshotSource;
  actor_sub: string | null;
  content_hash: string;
  import_id: string | null;
  doc_modified_time: Date | null;
  modified_by: string | null;
  created_at: Date;
  page: Page;
};

const COLUMNS = "id, file_id, revision_id, source, actor_sub, content_hash, import_id, doc_modified_time, modified_by, created_at, page";

function toSnapshot(row: Row): Snapshot {
  return {
    id: row.id,
    fileId: row.file_id,
    revisionId: row.revision_id,
    source: row.source,
    actorSub: row.actor_sub,
    contentHash: row.content_hash,
    importId: row.import_id,
    docModifiedTime: row.doc_modified_time ? row.doc_modified_time.toISOString() : null,
    modifiedBy: row.modified_by,
    createdAt: row.created_at.toISOString(),
    page: row.page,
  };
}

export type NewSnapshot = {
  page: Page;
  source: SnapshotSource;
  actorSub: string | null;
  docModifiedTime?: string | null;
  modifiedBy?: string | null;
  importId?: string | null;
};

/**
 * Stores a snapshot. The same revision and source twice is one row (a retried
 * call), and a revision identical to the newest snapshot of the same source
 * (same id and content) is not stored again. Returns whether a row was written.
 */
export async function recordSnapshot(input: NewSnapshot): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const { page } = input;
  const hash = contentHash(page);
  const latest = await query<{ content_hash: string; revision_id: string }>(
    "SELECT content_hash, revision_id FROM page_snapshots WHERE file_id = $1 AND source = $2 ORDER BY id DESC LIMIT 1",
    [page.fileId, input.source],
  );
  if (latest[0] && latest[0].content_hash === hash && latest[0].revision_id === page.revisionId) return false;
  const inserted = await query<{ id: string }>(
    `INSERT INTO page_snapshots (file_id, revision_id, source, actor_sub, content_hash, doc_modified_time, modified_by, page, import_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (file_id, revision_id, source) DO NOTHING
     RETURNING id`,
    [page.fileId, page.revisionId, input.source, input.actorSub, hash, input.docModifiedTime ?? null, input.modifiedBy ?? null, JSON.stringify(page), input.importId ?? null],
  );
  await pruneSnapshots(page.fileId);
  return inserted.length > 0;
}

/** Deletes all but the newest SNAPSHOTS_PER_DOC snapshots of a Doc, never its newest published one. */
export async function pruneSnapshots(fileId: string): Promise<void> {
  await query(
    `DELETE FROM page_snapshots
     WHERE file_id = $1
       AND id NOT IN (SELECT id FROM page_snapshots WHERE file_id = $1 ORDER BY id DESC LIMIT $2)
       AND id <> COALESCE((SELECT id FROM page_snapshots WHERE file_id = $1 AND source = 'publish' ORDER BY id DESC LIMIT 1), 0)`,
    [fileId, SNAPSHOTS_PER_DOC],
  );
}

/** The newest snapshot, optionally of one source. */
export async function latestSnapshot(fileId: string, source?: SnapshotSource): Promise<Snapshot | null> {
  if (!databaseConfigured()) return null;
  const rows = source
    ? await query<Row>(`SELECT ${COLUMNS} FROM page_snapshots WHERE file_id = $1 AND source = $2 ORDER BY id DESC LIMIT 1`, [fileId, source])
    : await query<Row>(`SELECT ${COLUMNS} FROM page_snapshots WHERE file_id = $1 ORDER BY id DESC LIMIT 1`, [fileId]);
  return rows[0] ? toSnapshot(rows[0]) : null;
}

/** What an import diffs against: the newest commit, publish or import snapshot. */
export const baseSnapshot = (fileId: string) => latestSnapshot(fileId);

/** What is live: the newest public publish. */
export const lastPublishedSnapshot = (fileId: string) => latestSnapshot(fileId, "publish");

/** The newest commit snapshot. */
export const lastCommittedSnapshot = (fileId: string) => latestSnapshot(fileId, "commit");

/** Newest snapshot per Doc, for a site-level check against Drive modified times (#30). */
export async function latestSnapshotTimes(fileIds: readonly string[]): Promise<Map<string, { revisionId: string; docModifiedTime: string | null; createdAt: string }>> {
  const out = new Map<string, { revisionId: string; docModifiedTime: string | null; createdAt: string }>();
  if (!databaseConfigured() || fileIds.length === 0) return out;
  const rows = await query<{ file_id: string; revision_id: string; doc_modified_time: Date | null; created_at: Date }>(
    `SELECT DISTINCT ON (file_id) file_id, revision_id, doc_modified_time, created_at
     FROM page_snapshots WHERE file_id = ANY($1) ORDER BY file_id, id DESC`,
    [[...fileIds]],
  );
  for (const row of rows) out.set(row.file_id, { revisionId: row.revision_id, docModifiedTime: row.doc_modified_time?.toISOString() ?? null, createdAt: row.created_at.toISOString() });
  return out;
}
