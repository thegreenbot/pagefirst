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

  return new NextResponse(Buffer.from(media.bytes), {
    headers: {
      "Content-Type": media.mime,
      "Cache-Control": "private, max-age=3600",
    },
  });
}
