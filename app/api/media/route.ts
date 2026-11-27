import { NextResponse } from "next/server";
import { callerKey, checkRateLimit, requireGoogleWriter, sameOrigin, tooManyRequests } from "@/lib/guard";
import { googleConfigured } from "@/lib/google/config";
import { saveMedia } from "@/lib/media";
import { auditRequest } from "@/lib/audit-request";

export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function looksLikeMarkup(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<html") || head.includes("<script");
}

export async function POST(request: Request) {
  const writer = await requireGoogleWriter();
  if (!writer.ok) {
    return NextResponse.json({ error: writer.error }, { status: 401 });
  }
  if (!googleConfigured() && !sameOrigin(request)) {
    return NextResponse.json({ error: "Sign in with Google to do this." }, { status: 401 });
  }
  const limit = checkRateLimit(`media:${callerKey(writer.token, request)}`, 8);
  if (!limit.ok) {
    await auditRequest(request, { event: "request.denied", outcome: "denied", status: 429, errorCode: "rate_limited:media" });
    return tooManyRequests("Too many uploads. Wait a minute.", limit.retryAfterSeconds);
  }

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const mime = (file.type || "application/octet-stream").split(";")[0]?.trim().toLowerCase();
  if (!mime || !ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 415 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (looksLikeMarkup(bytes)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 415 });
  }

  try {
    const { id } = saveMedia(bytes, mime);
    await auditRequest(request, { event: "media.upload", outcome: "ok", fileId: id, status: 200 });
    return NextResponse.json({ id, driveFileId: id });
  } catch (error) {
    if (error instanceof Error && error.message === "Image is too large") {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof Error && error.message === "Image library is full") {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    throw error;
  }
}
