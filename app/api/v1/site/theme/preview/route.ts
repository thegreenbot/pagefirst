import { ownSite, themeError } from "@/lib/api/site";
import { readJson, v1 } from "@/lib/api/v1";
import { getPage } from "@/lib/service";
import { previewChange } from "@/lib/site/theme-preview";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A dry run of a theme change over a sample of the site's published pages. Nothing is saved to the theme. */
export function POST(request: Request) {
  return v1(request, "v1-site-theme-preview", 10, async (ctx) => {
    const siteId = await ownSite(ctx, "pages:read");
    const body = await readJson(request, 256 * 1024);
    try {
      return await previewChange(siteId, body, {
        loadPage: async (fileId) => {
          const payload = await getPage(ctx, fileId);
          return payload && !payload.sample ? payload.page : null;
        },
      });
    } catch (error) {
      return themeError(error);
    }
  });
}
