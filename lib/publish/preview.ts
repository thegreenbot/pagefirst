import { databaseConfigured, query } from "@/lib/db/client";

/**
 * Published previews (#18): in Postgres when it is configured, so every
 * instance serves the same copy, otherwise in this process's memory. Each
 * preview keeps the CSP it was rendered for, since the style hash is per page.
 */

/** A rendered page and the CSP it was rendered for. */
export type Preview = { html: string; csp: string };

const previewHolder = globalThis as typeof globalThis & {
  __pageFirstPreviewPages?: Map<string, Preview>;
};

const previews: Map<string, Preview> = previewHolder.__pageFirstPreviewPages ?? new Map<string, Preview>();

previewHolder.__pageFirstPreviewPages = previews;

const MAX_PREVIEWS = 40;
export const MAX_PREVIEW_HTML = 500_000;

export async function savePreview(fileId: string, html: string, csp: string, revisionId: string | null = null): Promise<void> {
  const stored = html.length > MAX_PREVIEW_HTML ? html.slice(0, MAX_PREVIEW_HTML) : html;
  if (databaseConfigured()) {
    await query(
      `INSERT INTO previews (file_id, revision_id, html, csp) VALUES ($1, $2, $3, $4)
       ON CONFLICT (file_id) DO UPDATE SET revision_id = EXCLUDED.revision_id, html = EXCLUDED.html,
         csp = EXCLUDED.csp, updated_at = now()`,
      [fileId, revisionId, stored, csp],
    );
    return;
  }
  if (!previews.has(fileId) && previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(fileId, { html: stored, csp });
}

/** A preview saved before CSPs were stored has none; it is served with no style allowed. */
const NO_STYLE_CSP = "default-src 'none'; script-src 'none'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'";

export async function readPreview(fileId: string): Promise<Preview | null> {
  if (databaseConfigured()) {
    const [row] = await query<{ html: string; csp: string | null }>("SELECT html, csp FROM previews WHERE file_id = $1", [fileId]);
    return row ? { html: row.html, csp: row.csp ?? NO_STYLE_CSP } : null;
  }
  return previews.get(fileId) ?? null;
}

/** Content-addressed files that previews reference, e.g. deferred CSS (#59). */
export type PreviewAsset = { path: string; contentType: string; body: string };

const assetHolder = globalThis as typeof globalThis & {
  __pageFirstPreviewAssets?: Map<string, PreviewAsset>;
};
const assets: Map<string, PreviewAsset> = assetHolder.__pageFirstPreviewAssets ?? new Map<string, PreviewAsset>();
assetHolder.__pageFirstPreviewAssets = assets;

const MAX_ASSETS = 200;
const MAX_ASSET_BYTES = 200_000;

export function savePreviewAssets(list: PreviewAsset[]): void {
  for (const asset of list) {
    if (asset.body.length > MAX_ASSET_BYTES) continue;
    assets.delete(asset.path);
    if (assets.size >= MAX_ASSETS) {
      const oldest = assets.keys().next().value;
      if (oldest) assets.delete(oldest);
    }
    assets.set(asset.path, asset);
  }
}

export function readPreviewAsset(path: string): PreviewAsset | null {
  return assets.get(path) ?? null;
}
