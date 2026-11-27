import { NextResponse } from "next/server";
import { readJson, v1 } from "@/lib/api/v1";
import { databaseConfigured } from "@/lib/db/client";
import { decisionsFor, DECISIONS, FINDINGS, isDecision, isFinding, recordDecision } from "@/lib/content-audit/decisions";
import { isSafeId } from "@/lib/page/types";
import { getPage, requireScope, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

function needDatabase(): void {
  if (!databaseConfigured()) throw new ServiceError("upstream_error", "Audit history needs the database.");
}

/** A page's audit decision history, newest first. */
export function GET(request: Request) {
  return v1(request, "v1-content-audit-decisions-list", 60, async (ctx) => {
    requireScope(ctx, "pages:read");
    const fileId = new URL(request.url).searchParams.get("fileId") ?? "";
    if (!isSafeId(fileId)) throw new ServiceError("invalid", "fileId is required.");
    // Reading the page first applies the credential's folder allow-list.
    if (!(await getPage(ctx, fileId))) throw new ServiceError("not_found", "Page not found.");
    needDatabase();
    return { decisions: await decisionsFor(fileId) };
  });
}

/** Records what a person decided about a flagged page. */
export function POST(request: Request) {
  return v1(request, "v1-content-audit-decisions-create", 60, async (ctx) => {
    requireScope(ctx, "pages:commit");
    const body = (await readJson(request, 8192)) as { fileId?: unknown; finding?: unknown; decision?: unknown; note?: unknown };
    if (typeof body.fileId !== "string" || !isSafeId(body.fileId)) throw new ServiceError("invalid", "fileId is required.");
    if (!isFinding(body.finding)) throw new ServiceError("invalid", `finding must be one of ${FINDINGS.join(", ")}.`);
    if (!isDecision(body.decision)) throw new ServiceError("invalid", `decision must be one of ${DECISIONS.join(", ")}.`);
    if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 1000)) throw new ServiceError("invalid", "note must be text up to 1000 characters.");
    const payload = await getPage(ctx, body.fileId);
    if (!payload) throw new ServiceError("not_found", "Page not found.");
    needDatabase();
    const decision = await recordDecision({
      fileId: body.fileId,
      actorSub: ctx.actor.sub,
      finding: body.finding,
      decision: body.decision,
      note: body.note as string | undefined,
      revisionId: payload.page.revisionId || null,
    });
    return NextResponse.json({ decision }, { status: 201 });
  }, { idempotent: true });
}
