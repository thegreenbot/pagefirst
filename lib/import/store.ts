import { randomUUID } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";

/** One row per import, dry runs included (#34). The id is what a later publish and its audit entry point back to. */
export type ImportRecord = {
  id: string;
  fileId: string;
  actorSub: string | null;
  policy: string;
  dryRun: boolean;
  fromRevisionId: string | null;
  toRevisionId: string;
  changeCount: number;
  conflictCount: number;
  adopted: number;
  suggestions: number;
  docAuthor: string | null;
  docModifiedTime: string | null;
  createdAt: string;
};

export function newImportId(): string {
  return `imp_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export async function recordImport(row: Omit<ImportRecord, "createdAt">): Promise<void> {
  if (!databaseConfigured()) return;
  await query(
    `INSERT INTO page_imports (id, file_id, actor_sub, policy, dry_run, from_revision_id, to_revision_id, change_count,
       conflict_count, adopted, suggestions, doc_author, doc_modified_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [row.id, row.fileId, row.actorSub, row.policy, row.dryRun, row.fromRevisionId, row.toRevisionId, row.changeCount, row.conflictCount, row.adopted, row.suggestions, row.docAuthor, row.docModifiedTime],
  );
}

type Row = {
  id: string;
  file_id: string;
  actor_sub: string | null;
  policy: string;
  dry_run: boolean;
  from_revision_id: string | null;
  to_revision_id: string;
  change_count: number;
  conflict_count: number;
  adopted: number;
  suggestions: number;
  doc_author: string | null;
  doc_modified_time: Date | null;
  created_at: Date;
};

export async function getImport(id: string): Promise<ImportRecord | null> {
  if (!databaseConfigured()) return null;
  const rows = await query<Row>("SELECT * FROM page_imports WHERE id = $1", [id]);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        fileId: row.file_id,
        actorSub: row.actor_sub,
        policy: row.policy,
        dryRun: row.dry_run,
        fromRevisionId: row.from_revision_id,
        toRevisionId: row.to_revision_id,
        changeCount: row.change_count,
        conflictCount: row.conflict_count,
        adopted: row.adopted,
        suggestions: row.suggestions,
        docAuthor: row.doc_author,
        docModifiedTime: row.doc_modified_time?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }
    : null;
}
