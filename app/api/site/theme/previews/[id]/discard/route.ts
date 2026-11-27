import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { isSafeId } from "@/lib/page/types";
import { requireSite } from "@/lib/site/request";
import { discardChange, PreviewError } from "@/lib/site/theme-preview";

export const dynamic = "force-dynamic";

/** Discards a theme change preview; the site keeps its theme (#66). */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const site = await requireSite(request, "site-theme", "admin");
  if (!site.ok) return site.response;
  try {
    await discardChange(site.siteId, id);
    await auditRequest(request, { event: "site.theme.discard", outcome: "ok", siteId: site.siteId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (!(error instanceof PreviewError)) throw error;
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
}
