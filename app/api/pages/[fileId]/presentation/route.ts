import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { isSafeId } from "@/lib/page/types";
import { configErrorResponse, readJsonBody, requireSite } from "@/lib/site/request";
import { savePresentation } from "@/lib/site/theme-config";

export const dynamic = "force-dynamic";

/** Saves a page's template and section styles in the app's store (#56). */
export async function PUT(request: Request, context: { params: Promise<{ fileId: string }> }) {
  const { fileId } = await context.params;
  if (!isSafeId(fileId)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const site = await requireSite(request, "presentation", "editor");
  if (!site.ok) return site.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const presentation = await savePresentation(site.siteId, fileId, read.body);
    await auditRequest(request, { event: "page.presentation", outcome: "ok", fileId });
    return NextResponse.json({ presentation });
  } catch (error) {
    await auditRequest(request, { event: "page.presentation", outcome: "error", fileId, status: 400, errorCode: "invalid_presentation" });
    return configErrorResponse(error);
  }
}
