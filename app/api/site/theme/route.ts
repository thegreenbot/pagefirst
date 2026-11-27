import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { configErrorResponse, readJsonBody, requireSite } from "@/lib/site/request";
import { lockedPackage, orphans, readSiteTheme, updateSiteTheme, type SiteThemeConfig } from "@/lib/site/theme-config";
import { PlanError } from "@/lib/tenant/plans";
import { tokenDefs } from "@/lib/theme/tokens";

export const dynamic = "force-dynamic";

async function describe(config: SiteThemeConfig) {
  const theme = await lockedPackage(config.lock.integrity);
  const { manifest } = theme;
  return {
    config,
    // Values the current theme no longer declares: kept, and shown to the author.
    orphans: orphans(config, theme),
    theme: {
      name: manifest.name,
      version: manifest.version,
      templates: manifest.templates,
      blocks: manifest.blocks,
      sectionStyles: manifest.sectionStyles ?? [],
      settings: manifest.settings ?? [],
      tokens: tokenDefs(theme),
    },
  };
}

/** The signed-in owner's site theme config (#56). */
export async function GET(request: Request) {
  const site = await requireSite(request, "site-theme");
  if (!site.ok) return site.response;
  return NextResponse.json(await describe(await readSiteTheme(site.siteId)));
}

export async function PUT(request: Request) {
  const site = await requireSite(request, "site-theme", "admin");
  if (!site.ok) return site.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const config = await updateSiteTheme(site.siteId, read.body);
    await auditRequest(request, { event: "site.theme.update", outcome: "ok" });
    return NextResponse.json(await describe(config));
  } catch (error) {
    const plan = error instanceof PlanError;
    await auditRequest(request, { event: "site.theme.update", outcome: "error", status: plan ? 402 : 400, errorCode: plan ? "plan_required" : "invalid_config" });
    return configErrorResponse(error);
  }
}
