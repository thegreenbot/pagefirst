import { ConfigError, siteForOwner } from "@/lib/site/theme-config";
import { PlanError } from "@/lib/tenant/plans";
import { requireScope, ServiceError, type ServiceContext } from "@/lib/service";

/** The calling credential's own site; theme operations need a signed-in owner. */
export async function ownSite(ctx: ServiceContext, scope: "pages:read" | "pages:publish"): Promise<string> {
  requireScope(ctx, scope);
  if (!ctx.actor.sub) throw new ServiceError("unsupported", "Theme operations need a signed-in account.");
  return siteForOwner(ctx.actor.sub);
}

/** Config and plan failures as service errors, so the API's one error shape applies. */
export function themeError(error: unknown): never {
  if (error instanceof ConfigError) throw new ServiceError("invalid", `${error.path}: ${error.message}`);
  if (error instanceof PlanError) throw new ServiceError("forbidden", `${error.message} (plan feature: ${error.feature})`);
  throw error;
}
