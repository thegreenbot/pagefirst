import { NextResponse } from "next/server";
import { requireSite } from "@/lib/site/request";
import { publishUsage } from "@/lib/tenant/limits";
import { gatingEnabled } from "@/lib/tenant/plans";

export const dynamic = "force-dynamic";

/** What the caller's site has published against its plan's limits (#195). Limits are null when unlimited or self-hosted. */
export async function GET(request: Request) {
  const site = await requireSite(request, "site-usage");
  if (!site.ok) return site.response;
  const usage = await publishUsage(site.siteId);
  const limited = gatingEnabled();
  return NextResponse.json({
    plan: usage.plan,
    livePages: usage.livePages,
    publishesToday: usage.publishesToday,
    limits: limited ? usage.limits : { livePages: null, publishesPerDay: null },
  });
}
