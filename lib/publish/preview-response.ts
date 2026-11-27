import { NextResponse } from "next/server";
import { readPreviewAsset } from "@/lib/publish/preview";

/** Serves a content-addressed preview asset, immutable, or 404. */
export function previewAssetResponse(path: string | null): NextResponse {
  const asset = path ? readPreviewAsset(path) : null;
  if (!asset) {
    return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const body = typeof asset.body === "string" ? asset.body : Buffer.from(asset.body);
  return new NextResponse(body, {
    headers: {
      "Content-Type": asset.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
