import { NextResponse } from "next/server";
import { isSafeId } from "@/lib/page/types";
import { readPreview } from "@/lib/publish/preview";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
) {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return new NextResponse("Invalid id", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const html = readPreview(fileId);
  if (html == null) {
    return new NextResponse("This page has not been published.", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
