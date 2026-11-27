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
