import { v1 } from "@/lib/api/v1";
import { isSafeId } from "@/lib/page/types";
import { getPage, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** The parsed page and its revisionId. */
export function GET(request: Request, context: { params: Promise<{ fileId: string }> }) {
  return v1(request, "v1-pages-get", 120, async (ctx) => {
    const { fileId } = await context.params;
    if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
    const payload = await getPage(ctx, fileId);
    if (!payload) throw new ServiceError("not_found", "Page not found.");
    return payload;
  });
}
