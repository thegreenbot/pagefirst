import { NextResponse } from "next/server";
import { isSafeId, type CommitResult, type Op } from "@/lib/page/types";
import { commitPage } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ fileId: string }> },
): Promise<NextResponse<CommitResult | { error: string }>> {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
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
