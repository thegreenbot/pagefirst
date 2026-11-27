import { databaseConfigured, query } from "@/lib/db/client";

/**
 * Published previews (#18): in Postgres when it is configured, so every
 * instance serves the same copy, otherwise in this process's memory.
 */

const previewHolder = globalThis as typeof globalThis & {
  __pageFirstPreviews?: Map<string, string>;
};

const previews: Map<string, string> = previewHolder.__pageFirstPreviews ?? new Map<string, string>();

previewHolder.__pageFirstPreviews = previews;

const MAX_PREVIEWS = 40;
export const MAX_PREVIEW_HTML = 500_000;

export async function savePreview(fileId: string, html: string, revisionId: string | null = null): Promise<void> {
  const stored = html.length > MAX_PREVIEW_HTML ? html.slice(0, MAX_PREVIEW_HTML) : html;
  if (databaseConfigured()) {
    await query(
      `INSERT INTO previews (file_id, revision_id, html) VALUES ($1, $2, $3)
       ON CONFLICT (file_id) DO UPDATE SET revision_id = EXCLUDED.revision_id, html = EXCLUDED.html, updated_at = now()`,
      [fileId, revisionId, stored],
    );
    return;
  }
  if (!previews.has(fileId) && previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(fileId, stored);
}

export async function readPreview(fileId: string): Promise<string | null> {
  if (databaseConfigured()) {
    const [row] = await query<{ html: string }>("SELECT html FROM previews WHERE file_id = $1", [fileId]);
    return row?.html ?? null;
  }
  return previews.get(fileId) ?? null;
}
