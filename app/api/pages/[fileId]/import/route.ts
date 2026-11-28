import { NextResponse } from "next/server";
import { readTextCapped } from "@/lib/http/body";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests, withRateLimit } from "@/lib/guard";
import { isSafeId, type Op } from "@/lib/page/types";
import { LIMITS, validateCommitRequest } from "@/lib/page/validate";
import { importPage, ServiceError, type ImportResult } from "@/lib/service";
import { sessionContext } from "@/lib/store";
import { auditRequest } from "@/lib/audit-request";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const IMPORT_LIMIT = 20;

/**
 * The editor's import review (#35). `{ dryRun: true, baseRevisionId, ops }` reports
 * what changed in the Doc and which of the editor's uncommitted ops conflict with it,
 * and writes nothing. `{ dryRun: false, expectRevisionId }` brings the Doc's changes
 * in (the Doc wins; the editor re-applies its own ops on top), pinned to the
 * revision that was reviewed.
 */
export async function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });

  const writer = await requireGoogleWriter();
  if (!writer.ok) return NextResponse.json({ error: writer.error }, { status: 401 });
  const limit = await checkRateLimit("import", callerKey(writer.token, request, writer.sub), IMPORT_LIMIT);
  if (!limit.ok) {
    await auditRequest(request, { event: "request.denied", outcome: "denied", fileId, status: 429, errorCode: "rate_limited:import" });
    return tooManyRequests("Too many import requests. Wait a moment.", limit);
  }

  const read = await readTextCapped(request, LIMITS.maxBodyBytes);
  if (!read.ok) return NextResponse.json({ error: "Request is too large" }, { status: 413 });
  let body: { dryRun?: unknown; expectRevisionId?: unknown; baseRevisionId?: unknown; ops?: unknown };
  try {
    body = JSON.parse(read.text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  const dryRun = body.dryRun !== false;

  let ops: Op[] = [];
  if (dryRun && Array.isArray(body.ops) && body.ops.length > 0) {
    const parsed = validateCommitRequest({ baseRevisionId: typeof body.baseRevisionId === "string" ? body.baseRevisionId : "base", ops: body.ops });
    if (!parsed.ok) return NextResponse.json({ error: `${parsed.path}: ${parsed.error}` }, { status: 400 });
    ops = parsed.value.ops;
  }
  if (!dryRun && typeof body.expectRevisionId !== "string") {
    return NextResponse.json({ error: "expectRevisionId is required to import." }, { status: 400 });
  }

  try {
    const result = await importPage(await sessionContext(request), fileId, {
      dryRun,
      policy: dryRun && ops.length > 0 ? "manual" : "doc-wins",
      draftOps: dryRun ? ops : undefined,
      expectRevisionId: dryRun ? undefined : (body.expectRevisionId as string),
    });
    await auditRequest(request, {
      event: "page.import",
      outcome: "ok",
      fileId,
      baseRevisionId: result.fromRevisionId,
      resultRevisionId: result.toRevisionId,
      importId: result.importId,
      docAuthor: result.docAuthor,
      changeCount: result.changes.length,
      status: 200,
    });
    const payload: ImportResult & { ok: true } = { ...result, ok: true };
    return withRateLimit(NextResponse.json(dryRun ? { ...payload, page: undefined } : payload), limit);
  } catch (error) {
    if (error instanceof ServiceError) {
      const message = error.code === "not_found" ? "Page not found" : error.message;
      await auditRequest(request, { event: "page.import", outcome: error.code === "conflict" ? "denied" : "error", fileId, status: error.status, errorCode: error.code });
      return NextResponse.json({ error: message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
