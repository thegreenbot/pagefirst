import { v1 } from "@/lib/api/v1";
import { availableThemes, siteForOwner } from "@/lib/site/theme-config";
import { requireScope } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Themes a site can choose: the registry's and the bundled ones. */
export function GET(request: Request) {
  return v1(request, "v1-themes", 120, async (ctx) => {
    requireScope(ctx, "pages:read");
    const siteId = ctx.siteId ?? (ctx.actor.sub ? await siteForOwner(ctx.actor.sub) : undefined);
    return { themes: await availableThemes(siteId) };
  });
}
