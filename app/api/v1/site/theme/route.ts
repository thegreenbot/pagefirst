import { ownSite, themeError } from "@/lib/api/site";
import { readJson, v1 } from "@/lib/api/v1";
import { lockedPackage, orphans, readSiteTheme, updateSiteTheme } from "@/lib/site/theme-config";
import { tokenDefs } from "@/lib/theme/tokens";

export const dynamic = "force-dynamic";

async function describe(siteId: string, config?: Awaited<ReturnType<typeof readSiteTheme>>) {
  const current = config ?? (await readSiteTheme(siteId));
  const theme = await lockedPackage(current.lock.integrity);
  return { config: current, orphans: orphans(current, theme), theme: { name: theme.manifest.name, version: theme.manifest.version, tokens: tokenDefs(theme), settings: theme.manifest.settings ?? [] } };
}

/** The calling credential's site theme: chosen theme, lock, tokens and settings. */
export function GET(request: Request) {
  return v1(request, "v1-site-theme-get", 120, async (ctx) => describe(await ownSite(ctx, "pages:read")));
}

/** Changes tokens, settings or the theme. Pages keep their old look until `POST /site/republish`. */
export function PUT(request: Request) {
  return v1(
    request,
    "v1-site-theme-set",
    20,
    async (ctx) => {
      const siteId = await ownSite(ctx, "pages:publish");
      const body = await readJson(request, 256 * 1024);
      try {
        return await describe(siteId, await updateSiteTheme(siteId, body));
      } catch (error) {
        return themeError(error);
      }
    },
    { idempotent: true, audit: "site.theme.update" },
  );
}
