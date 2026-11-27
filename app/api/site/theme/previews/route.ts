import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { configErrorResponse, readJsonBody, requireSite } from "@/lib/site/request";
import { previewChange } from "@/lib/site/theme-preview";
import { getPage } from "@/lib/store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Runs a theme change as a dry run (#66). The body is the same change PUT /api/site/theme takes. */
export async function POST(request: Request) {
  const site = await requireSite(request, "site-theme-preview", "admin");
  if (!site.ok) return site.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  try {
    const preview = await previewChange(site.siteId, read.body, {
      loadPage: async (fileId) => {
        const payload = await getPage(fileId);
        return payload && !payload.sample ? payload.page : null;
      },
    });
    await auditRequest(request, { event: "site.theme.preview", outcome: "ok", siteId: site.siteId });
    return NextResponse.json(preview);
  } catch (error) {
    await auditRequest(request, { event: "site.theme.preview", outcome: "error", status: 400, errorCode: "invalid_config", siteId: site.siteId });
    return configErrorResponse(error);
  }
}
