import { NextResponse } from "next/server";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { isSafeId, type CommitResult, type Op } from "@/lib/page/types";
import { commitPage } from "@/lib/store";

export const dynamic = "force-dynamic";

/** Commits per caller per minute: generous for an author typing then committing. */
const COMMIT_LIMIT = 30;

export async function POST(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<CommitResult | { error: string }>> {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json(
      { error: "Expected baseRevisionId and ops" },
      { status: 400 },
    );
  }

  const { baseRevisionId, ops } = body as {
    baseRevisionId?: unknown;
    ops?: unknown;
  };
  if (!Array.isArray(ops)) {
    return NextResponse.json({ error: "ops must be an array" }, { status: 400 });
  }
  if (typeof baseRevisionId !== "string") {
    return NextResponse.json(
      { error: "baseRevisionId must be a string" },
      { status: 400 },
    );
  }

  const result = await commitPage(fileId, baseRevisionId, ops as Op[]);
  return NextResponse.json(result, { status: result.ok ? 200 : result.status });
}
