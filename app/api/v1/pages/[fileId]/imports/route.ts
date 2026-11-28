import { v1, readJson } from "@/lib/api/v1";
import { clientIp, recordAudit } from "@/lib/audit";
import { isSafeId } from "@/lib/page/types";
import { importAndPublish, importPage, isConflictPolicy, ServiceError, type ImportResult } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const summary = (result: ImportResult) => {
  // The merged page is for the editor; the REST report is the change list.
  const { page: _page, ...rest } = result;
  void _page;
  return rest;
};

/**
 * Imports the Doc's changes: `{ policy?, dryRun?, publish? }`. `dryRun` defaults
 * to true, so a call with an empty body only reports. `publish: { public?, allowSuggestions? }`
 * imports and then publishes exactly the revision imported, unless a conflict
 * needs a person. Nothing is published without `publish`.
 */
export function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  return v1(
    request,
    "v1-import",
    20,
    async (ctx, _request, note, credential) => {
      const { fileId } = await context.params;
      if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
      const body = (await readJson(request, 4096)) as { policy?: unknown; dryRun?: unknown; publish?: unknown };
      if (body.policy !== undefined && !isConflictPolicy(body.policy)) throw new ServiceError("invalid", "policy must be manual, doc-wins, draft-wins or fail.");
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new ServiceError("invalid", "dryRun must be true or false.");
      const dryRun = body.dryRun !== false;
      note.fileId = fileId;

      if (body.publish !== undefined && body.publish !== false) {
        if (dryRun) throw new ServiceError("invalid", "publish needs dryRun: false.");
        const options = (typeof body.publish === "object" && body.publish !== null ? body.publish : {}) as { public?: unknown; allowSuggestions?: unknown };
        if ((options.public !== undefined && typeof options.public !== "boolean") || (options.allowSuggestions !== undefined && typeof options.allowSuggestions !== "boolean")) {
          throw new ServiceError("invalid", "publish.public and publish.allowSuggestions must be true or false.");
        }
        const done = await importAndPublish(ctx, fileId, { policy: body.policy as never, public: options.public === true, allowSuggestions: options.allowSuggestions === true });
        const imported = done.import;
        Object.assign(note, { baseRevisionId: imported.fromRevisionId, resultRevisionId: imported.toRevisionId, importId: imported.importId, docAuthor: imported.docAuthor, changeCount: imported.changes.length });
        if (done.publish) {
          // The import and the publish are two audit entries sharing one import id.
          await recordAudit({
            event: "page.publish",
            outcome: done.publish.audit.outcome,
            status: 200,
            errorCode: done.publish.audit.errorCode,
            requestId: ctx.requestId,
            idempotencyKey: ctx.idempotencyKey ?? null,
            actorSub: ctx.actor.sub,
            actorKey: `${credential.kind}:${credential.id}`,
            client: ctx.actor.client,
            ip: clientIp(request),
            fileId,
            resultRevisionId: done.publish.audit.resultRevisionId,
            siteId: done.publish.audit.siteId,
            pagePath: done.publish.audit.pagePath,
            importId: imported.importId,
            docAuthor: imported.docAuthor,
            changeCount: imported.changes.length,
          });
        }
        return { ...summary(imported), published: done.publish ? done.publish.response : null, heldBack: done.reason };
      }

      const result = await importPage(ctx, fileId, { policy: body.policy as never, dryRun });
      Object.assign(note, { baseRevisionId: result.fromRevisionId, resultRevisionId: result.toRevisionId, importId: result.importId, docAuthor: result.docAuthor, changeCount: result.changes.length });
      return summary(result);
    },
    { idempotent: true, audit: "page.import" },
  );
}
