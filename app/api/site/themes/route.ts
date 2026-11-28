import { NextResponse } from "next/server";
import { requireSite } from "@/lib/site/request";
import { availableThemes } from "@/lib/site/theme-config";

export const dynamic = "force-dynamic";

/** Themes the signed-in owner's site can switch to (#64): registry versions, then bundled ones not yet published. */
export async function GET(request: Request) {
  const site = await requireSite(request, "site-theme");
  if (!site.ok) return site.response;
  return NextResponse.json({ themes: await availableThemes(site.siteId) });
}
