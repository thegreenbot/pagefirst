import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { readJsonBody, requireSite } from "@/lib/site/request";
import { setSpeedReport, speedReport } from "@/lib/site/speed";
import { vitalsEndpoint } from "@/lib/site/theme-config";

export const dynamic = "force-dynamic";

/** The site's field speed report: p75 LCP, CLS and INP per page (#70). */
export async function GET(request: Request) {
  const site = await requireSite(request, "site-speed");
  if (!site.ok) return site.response;
  const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
  return NextResponse.json({ ...(await speedReport(site.siteId, Number.isFinite(days) ? days : 7)), collector: vitalsEndpoint() !== null });
}

/** Turns the beacon on or off: `{ enabled: boolean }`. Pages carry it from their next publish. */
export async function PUT(request: Request) {
  const site = await requireSite(request, "site-speed", "admin");
  if (!site.ok) return site.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const enabled = (read.body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  if (enabled && vitalsEndpoint() === null) {
    return NextResponse.json({ error: "The speed beacon needs the app's public https address (APP_URL)." }, { status: 409 });
  }
  await setSpeedReport(site.siteId, enabled);
  await auditRequest(request, { event: "site.speed_report", outcome: "ok", siteId: site.siteId, status: 200 });
  return NextResponse.json({ enabled });
}
