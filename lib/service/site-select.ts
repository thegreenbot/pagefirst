import { canAccessSite } from "@/lib/tenant/orgs";
import { ServiceError, type ServiceContext } from "./context";

/**
 * Applies an `X-Pagefirst-Site` header to a context (#45): publishing and theme
 * calls then act on that organization site. Editors and above may; a site the
 * caller can't see looks like one that doesn't exist.
 */
export async function applySiteHeader(ctx: ServiceContext, request: Request): Promise<void> {
  const requested = request.headers.get("x-pagefirst-site");
  if (!requested) return;
  const sub = ctx.actor.sub;
  if (!sub || !/^[\w-]{1,64}$/.test(requested) || !(await canAccessSite(sub, requested, "viewer"))) throw new ServiceError("not_found", "Site not found.");
  if (!(await canAccessSite(sub, requested, "editor"))) throw new ServiceError("forbidden", "Publishing to this site needs the editor role in its organization.");
  ctx.siteId = requested;
}
