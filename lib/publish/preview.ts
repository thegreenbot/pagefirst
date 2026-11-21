const previewHolder = globalThis as typeof globalThis & {
  __pageFirstPreviews?: Map<string, string>;
};

const previews: Map<string, string> =
  previewHolder.__pageFirstPreviews ?? new Map<string, string>();

previewHolder.__pageFirstPreviews = previews;

const MAX_PREVIEWS = 40;
const MAX_HTML = 500_000;

export function savePreview(fileId: string, html: string): void {
  const stored = html.length > MAX_HTML ? html.slice(0, MAX_HTML) : html;
  if (!previews.has(fileId) && previews.size >= MAX_PREVIEWS) {
    const oldest = previews.keys().next().value;
    if (oldest) previews.delete(oldest);
  }
  previews.set(fileId, stored);
}

export function readPreview(fileId: string): string | null {
  return previews.get(fileId) ?? null;
}
