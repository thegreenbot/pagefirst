import { NextResponse } from "next/server";
import { isSafeId, type PagePayload } from "@/lib/page/types";
import { getPage } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<PagePayload | { error: string }>> {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const payload = await getPage(fileId);
  if (!payload) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }
  return NextResponse.json(payload);
}
