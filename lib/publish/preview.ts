const previewHolder = globalThis as typeof globalThis & {
  __pageFirstPreviews?: Map<string, string>;
};

const previews: Map<string, string> =
  previewHolder.__pageFirstPreviews ?? new Map<string, string>();

previewHolder.__pageFirstPreviews = previews;

export function savePreview(fileId: string, html: string): void {
  previews.set(fileId, html);
}

export function readPreview(fileId: string): string | null {
  return previews.get(fileId) ?? null;
}
