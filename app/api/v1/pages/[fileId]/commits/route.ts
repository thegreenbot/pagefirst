import { v1, readJson } from "@/lib/api/v1";
import { isSafeId } from "@/lib/page/types";
import { LIMITS, validateCommitRequest } from "@/lib/page/validate";
import { commit, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Applies ops against a base revision. A stale base is `revision_conflict` with the current revision in details. */
export function POST(request: Request, context: { params: Promise<{ fileId: string }> }) {
  return v1(request, "v1-commit", 60, async (ctx) => {
    const { fileId } = await context.params;
    if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
    const parsed = validateCommitRequest(await readJson(request, LIMITS.maxBodyBytes));
    if (!parsed.ok) throw new ServiceError("invalid", `${parsed.path}: ${parsed.error}`);
    const result = await commit(ctx, fileId, parsed.value.baseRevisionId, parsed.value.ops);
    if (!result.ok) {
      const code = result.status === 409 ? "conflict" : result.status === 404 ? "not_found" : result.status === 429 ? "upstream_quota" : result.status === 501 ? "unsupported" : result.status === 401 ? "unauthenticated" : result.status === 403 ? "forbidden" : result.status === 400 ? "invalid" : "upstream_error";
      throw new ServiceError(code, result.error, { page: result.page });
    }
    return result;
  });
}
