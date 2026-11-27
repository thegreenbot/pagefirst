import { previewAssetResponse } from "@/lib/publish/preview-response";

export const dynamic = "force-dynamic";

/** Deferred CSS (#59) and island modules (#60) for published previews. Names are content hashes, so they never change. */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  return previewAssetResponse(/^[a-f0-9]{16}\.(css|js)$/.test(file) ? `assets/pf/${file}` : null);
}
