import { ConfigError, siteForOwner } from "@/lib/site/theme-config";
import { PlanError } from "@/lib/tenant/plans";
import { canAccessSite } from "@/lib/tenant/orgs";
import { requireScope, ServiceError, type ServiceContext } from "@/lib/service";

/** The calling credential's own site; theme operations need a signed-in owner. */
export async function ownSite(ctx: ServiceContext, scope: "pages:read" | "pages:publish", needsAdmin = false): Promise<string> {
  requireScope(ctx, scope);
  if (!ctx.actor.sub) throw new ServiceError("unsupported", "Theme operations need a signed-in account.");
  if (ctx.siteId) {
    // Changing an organization site's theme is an admin act, as in the browser (publishing needs editor).
    if (needsAdmin && !(await canAccessSite(ctx.actor.sub, ctx.siteId, "admin"))) throw new ServiceError("forbidden", "Changing the theme of an organization site needs the admin role.");
    return ctx.siteId;
  }
  return siteForOwner(ctx.actor.sub);
}

/** Config and plan failures as service errors, so the API's one error shape applies. */
export function themeError(error: unknown): never {
  if (error instanceof ConfigError) throw new ServiceError("invalid", `${error.path}: ${error.message}`);
  if (error instanceof PlanError) throw new ServiceError("forbidden", `${error.message} (plan feature: ${error.feature})`);
  throw error;
}
