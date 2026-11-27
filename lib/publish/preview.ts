/** A rendered page and the CSP it was rendered for. */
export type Preview = { html: string; csp: string };

const previewHolder = globalThis as typeof globalThis & {
  __pageFirstPreviewPages?: Map<string, Preview>;
};

const previews: Map<string, Preview> =
  previewHolder.__pageFirstPreviewPages ?? new Map<string, Preview>();

previewHolder.__pageFirstPreviewPages = previews;

const MAX_PREVIEWS = 40;
const MAX_HTML = 500_000;

export function savePreview(fileId: string, html: string, csp: string): void {
  const stored = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  if (!previews.has(fileId) && previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(fileId, { html: stored, csp });
}

export function readPreview(fileId: string): Preview | null {
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
