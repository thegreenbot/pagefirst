import { previewAssetResponse } from "@/lib/publish/preview-response";

export const dynamic = "force-dynamic";

/** Image renditions for published previews (#61). Names are content hashes, so they never change. */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  return previewAssetResponse(/^[a-f0-9]{16}-\d{1,4}\.(avif|webp)$/.test(file) ? `assets/img/${file}` : null);
}
