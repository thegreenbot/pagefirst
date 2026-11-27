import { NextResponse } from "next/server";
import { readPreviewAsset } from "@/lib/publish/preview";

export const dynamic = "force-dynamic";

/** Deferred CSS for published previews (#59). Names are content hashes, so they never change. */
export async function GET(_request: Request, context: { params: Promise<{ file: string }> }) {
  const { file } = await context.params;
  const asset = /^[a-f0-9]{16}\.css$/.test(file) ? readPreviewAsset(`assets/pf/${file}`) : null;
  if (!asset) {
    return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new NextResponse(asset.body, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
