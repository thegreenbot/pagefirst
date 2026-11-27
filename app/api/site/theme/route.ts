import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { configErrorResponse, readJsonBody, requireSite } from "@/lib/site/request";
import { lockedPackage, readSiteTheme, updateSiteTheme, type SiteThemeConfig } from "@/lib/site/theme-config";

export const dynamic = "force-dynamic";

async function describe(config: SiteThemeConfig) {
  const { manifest } = await lockedPackage(config.lock.integrity);
  return {
    config,
    theme: {
      name: manifest.name,
      version: manifest.version,
      templates: manifest.templates,
      blocks: manifest.blocks,
      sectionStyles: manifest.sectionStyles ?? [],
      settings: manifest.settings ?? [],
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
  const site = await requireSite(request, "site-theme");
  if (!site.ok) return site.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const config = await updateSiteTheme(site.siteId, read.body);
    await auditRequest(request, { event: "site.theme.update", outcome: "ok" });
    return NextResponse.json(await describe(config));
  } catch (error) {
    await auditRequest(request, { event: "site.theme.update", outcome: "error", status: 400, errorCode: "invalid_config" });
    return configErrorResponse(error);
  }
}
