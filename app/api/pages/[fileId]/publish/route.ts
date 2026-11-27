import { NextResponse } from "next/server";
import { callerKey, checkRateLimit, requireGoogleWriter, sameOrigin, tooManyRequests, withRateLimit } from "@/lib/guard";
import { googleConfigured } from "@/lib/google/config";
import { isSafeId } from "@/lib/page/types";
import { publish, ServiceError, type PublishResponse } from "@/lib/service";
import { sessionContext } from "@/lib/store";
import { auditRequest } from "@/lib/audit-request";

export const dynamic = "force-dynamic";

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

  try {
    const { response, audit } = await publish(await sessionContext(request), fileId, { public: wantsPublic });
    await auditRequest(request, {
      event: "page.publish",
      outcome: audit.outcome,
      fileId,
      resultRevisionId: audit.resultRevisionId,
      status: 200,
      errorCode: audit.errorCode,
      siteId: audit.siteId,
      pagePath: audit.pagePath,
    });
    return withRateLimit(NextResponse.json(response), limit);
  } catch (error) {
    if (error instanceof ServiceError) {
      const message = error.code === "not_found" ? "Page not found" : error.message;
      return NextResponse.json({ error: message }, { status: error.status });
    }
    throw error;
  }
}
