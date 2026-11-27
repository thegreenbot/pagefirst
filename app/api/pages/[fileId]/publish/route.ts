import { NextResponse } from "next/server";
import { callerKey, checkRateLimit, requireGoogleWriter, sameOrigin, tooManyRequests } from "@/lib/guard";
import { googleConfigured } from "@/lib/google/config";
import { isSafeId, type PublishResult } from "@/lib/page/types";
import { renderPublishHtml } from "@/lib/page/render";
import { uploadToCloudflare } from "@/lib/publish/cloudflare";
import { savePreview } from "@/lib/publish/preview";
import { getPage } from "@/lib/store";

export const dynamic = "force-dynamic";

type PublishResponse = PublishResult & { warning?: string };

export async function POST(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<PublishResponse | { error: string }>> {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const writer = await requireGoogleWriter();
  if (!writer.ok) {
    return NextResponse.json({ error: writer.error }, { status: 401 });
  }
  if (!googleConfigured() && !sameOrigin(request)) {
    return NextResponse.json({ error: "Sign in with Google to publish." }, { status: 401 });
  }
  const limit = checkRateLimit(`publish:${callerKey(writer.token, request)}`, 6);
  if (!limit.ok) {
    return tooManyRequests("Too many publish requests. Wait a minute.", limit.retryAfterSeconds);
  }

  let wantsPublic = false;
  try {
    const incoming = await request.json();
    wantsPublic =
      typeof incoming === "object" &&
      incoming !== null &&
      (incoming as { public?: unknown }).public === true;
  } catch {
    wantsPublic = false;
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

  if (!wantsPublic) return NextResponse.json(body);

  if (!writer.token) {
    body.warning = "Sign in with Google before publishing a public copy.";
    return NextResponse.json(body);
  }

  try {
    const url = await uploadToCloudflare(payload.page.path, html);
    if (url) body.url = url;
    else body.warning = "Cloudflare did not return a page address.";
  } catch (error) {
    body.warning = error instanceof Error ? error.message : "Cloudflare upload failed";
  }

  return NextResponse.json(body);
}
