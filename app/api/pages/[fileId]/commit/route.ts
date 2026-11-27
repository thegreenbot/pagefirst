import { NextResponse } from "next/server";
import { readTextCapped } from "@/lib/http/body";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { isSafeId, type CommitResult } from "@/lib/page/types";
import { LIMITS, validateCommitRequest } from "@/lib/page/validate";
import { commitPage } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Commits per caller per minute: generous for an author typing then committing. */
const COMMIT_LIMIT = 30;

export async function POST(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<CommitResult | { error: string; path?: string }>> {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  // Middleware has already refused cross-site and non-JSON requests.
  const writer = await requireGoogleWriter();
  if (!writer.ok) {
    return NextResponse.json({ error: writer.error }, { status: 401 });
  }
  const limit = checkRateLimit(`commit:${callerKey(writer.token, request)}`, COMMIT_LIMIT);
  if (!limit.ok) {
    return tooManyRequests("Too many saves. Wait a moment and try again.", limit.retryAfterSeconds);
  }

  const read = await readTextCapped(request, LIMITS.maxBodyBytes);
  if (!read.ok) {
    return NextResponse.json({ error: "Request is too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = validateCommitRequest(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: `${parsed.path}: ${parsed.error}`, path: parsed.path }, { status: 400 });
  }
  const { baseRevisionId, ops } = parsed.value;

  const result = await commitPage(fileId, baseRevisionId, ops);
  return NextResponse.json(result, { status: result.ok ? 200 : result.status });
}
