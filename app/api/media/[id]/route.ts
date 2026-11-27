import { NextResponse } from "next/server";
import { readMedia } from "@/lib/media";
import { isSafeId } from "@/lib/page/types";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  if (!isSafeId(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const media = readMedia(id);
  if (!media) {
    return NextResponse.json({ error: "Media not found" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Content-Type": media.mime,
    "Cache-Control": "private, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    // Opened directly, the file downloads instead of rendering as a page.
    // <img> tags ignore this header, so the editor and previews still show it.
    "Content-Disposition": `attachment; filename="${id}"`,
    "Content-Security-Policy": "default-src 'none'; script-src 'none'; sandbox",
    "Cross-Origin-Resource-Policy": "same-origin",
  };

  return new NextResponse(Buffer.from(media.bytes), { headers });
}
