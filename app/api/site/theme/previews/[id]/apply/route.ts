import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { isSafeId } from "@/lib/page/types";
import { requireSite } from "@/lib/site/request";
import { applyChange, PreviewError } from "@/lib/site/theme-preview";

export const dynamic = "force-dynamic";

/** Applies a previewed theme change and returns the pages to republish (#66). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const site = await requireSite(request, "site-theme");
  if (!site.ok) return site.response;
  try {
    const applied = await applyChange(site.siteId, id);
    await auditRequest(request, { event: "site.theme.apply", outcome: "ok", siteId: site.siteId });
    return NextResponse.json(applied);
  } catch (error) {
    if (!(error instanceof PreviewError)) throw error;
    await auditRequest(request, { event: "site.theme.apply", outcome: "denied", status: error.status, errorCode: "preview_stale", siteId: site.siteId });
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
}
