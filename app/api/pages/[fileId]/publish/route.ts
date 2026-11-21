import { NextResponse } from "next/server";
import { isSafeId, type PublishResult } from "@/lib/page/types";
import { renderPublishHtml } from "@/lib/page/render";
import { uploadToCloudflare } from "@/lib/publish/cloudflare";
import { savePreview } from "@/lib/publish/preview";
import { getPage } from "@/lib/store";

export const dynamic = "force-dynamic";

type PublishResponse = PublishResult & { warning?: string };

export async function POST(
  _request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<PublishResponse | { error: string }>> {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const payload = await getPage(fileId);
  if (!payload) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  const html = await renderPublishHtml(payload.page);
  savePreview(fileId, html);

  const body: PublishResponse = {
    ok: true,
    sample: payload.sample,
    previewPath: `/published/${fileId}`,
  };

  try {
    const url = await uploadToCloudflare(payload.page.path, html);
    if (url) body.url = url;
  } catch (error) {
    body.warning = error instanceof Error ? error.message : "Cloudflare upload failed";
  }

  return NextResponse.json(body);
}
