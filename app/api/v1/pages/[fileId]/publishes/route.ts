import { v1, readJson } from "@/lib/api/v1";
import { isSafeId } from "@/lib/page/types";
import { publish, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Publishes a pinned revision: a preview, or the public copy with `public: true`. */
export function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  return v1(request, "v1-publish", 6, async (ctx) => {
    const { fileId } = await context.params;
    if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
    const body = (await readJson(request, 4096)) as { revisionId?: unknown; public?: unknown };
    if (typeof body?.revisionId !== "string" || !body.revisionId) throw new ServiceError("invalid", "revisionId is required: publish a pinned revision.");
    const { response } = await publish(ctx, fileId, { revisionId: body.revisionId, public: body.public === true });
    return response;
  }, { idempotent: true });
}
