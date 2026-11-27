import { NextResponse } from "next/server";
import { callerKey, checkRateLimit, requireGoogleWriter, sameOrigin, tooManyRequests, withRateLimit } from "@/lib/guard";
import { googleConfigured } from "@/lib/google/config";
import { fetchGoogleIdentity } from "@/lib/google/userinfo";
import { mayPublishPublicly } from "@/lib/publish/allowlist";
import { isSafeId, type PublishResult } from "@/lib/page/types";
import { renderPageHtml } from "@/lib/page/render";
import { uploadToCloudflare } from "@/lib/publish/cloudflare";
import { savePreview, savePreviewAssets } from "@/lib/publish/preview";
import { getPage } from "@/lib/store";
import { auditRequest } from "@/lib/audit-request";

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
  const limit = await checkRateLimit("publish", callerKey(writer.token, request, writer.sub), 6);
  if (!limit.ok) {
    await auditRequest(request, { event: "request.denied", outcome: "denied", fileId, status: 429, errorCode: "rate_limited:publish" });
    return tooManyRequests("Too many publish requests. Wait a minute.", limit);
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

  const { html, csp, assets } = renderPageHtml(payload.page, "publish");
  // In memory for now; the R2 publish path (#63, #94) uploads these with the page.
  savePreviewAssets(assets);
  await savePreview(fileId, html, csp, payload.page.revisionId);

  const body: PublishResponse = {
    ok: true,
    sample: payload.sample,
    previewPath: `/published/${fileId}`,
  };

  const audit = (outcome: "ok" | "denied" | "error", errorCode: string | null) =>
    auditRequest(request, {
      event: "page.publish",
      outcome,
      fileId,
      resultRevisionId: payload.page.revisionId,
      status: 200,
      errorCode,
    });

  if (!wantsPublic) {
    await audit("ok", "preview");
    return withRateLimit(NextResponse.json(body), limit);
  }

  if (!writer.token) {
    body.warning = "Sign in with Google before publishing a public copy.";
    await audit("denied", "public:signed_out");
    return withRateLimit(NextResponse.json(body), limit);
  }

  const identity = await fetchGoogleIdentity(writer.token);
  if (!mayPublishPublicly(identity?.email ?? null)) {
    body.warning = "Public publishing is limited to approved accounts for now. Your preview is ready.";
    await audit("denied", "public:not_allowed");
    return withRateLimit(NextResponse.json(body), limit);
  }

  try {
    const url = await uploadToCloudflare(payload.page.path, html);
    if (url) body.url = url;
    else body.warning = "Cloudflare did not return a page address.";
  } catch (error) {
    body.warning = error instanceof Error ? error.message : "Cloudflare upload failed";
  }
  await audit(body.url ? "ok" : "error", body.url ? "public" : "public:upload_failed");

  return withRateLimit(NextResponse.json(body), limit);
}
