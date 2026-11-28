import { v1, readJson } from "@/lib/api/v1";
import { isSafeId } from "@/lib/page/types";
import { getImport } from "@/lib/import/store";
import { publish, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Publishes a pinned revision: a preview, or the public copy with `public: true`. */
export function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  return v1(request, "v1-publish", 6, async (ctx, _request, note) => {
    const { fileId } = await context.params;
    if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
    const body = (await readJson(request, 4096)) as { revisionId?: unknown; public?: unknown; importId?: unknown; allowSuggestions?: unknown };
    if (typeof body?.revisionId !== "string" || !body.revisionId) throw new ServiceError("invalid", "revisionId is required: publish a pinned revision.");
    if (body.allowSuggestions !== undefined && typeof body.allowSuggestions !== "boolean") throw new ServiceError("invalid", "allowSuggestions must be true or false.");
    // An import id links this publish to the import that produced the revision.
    let importId: string | undefined;
    if (body.importId !== undefined) {
      if (typeof body.importId !== "string") throw new ServiceError("invalid", "importId must be text.");
      const found = await getImport(body.importId);
      if (!found || found.fileId !== fileId || found.actorSub !== ctx.actor.sub) throw new ServiceError("invalid", "importId does not match an import of this page by this account.");
      importId = found.id;
      Object.assign(note, { docAuthor: found.docAuthor, changeCount: found.changeCount });
    }
    note.fileId = fileId;
    const { response, audit } = await publish(ctx, fileId, { revisionId: body.revisionId, public: body.public === true, allowSuggestions: body.allowSuggestions === true, ...(importId ? { importId } : {}) });
    Object.assign(note, { resultRevisionId: audit.resultRevisionId, siteId: audit.siteId, pagePath: audit.pagePath, ...(importId ? { importId } : {}) });
    return response;
  }, { idempotent: true, audit: "page.publish" });
}
