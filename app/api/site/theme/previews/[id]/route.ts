import { NextResponse } from "next/server";
import { isSafeId } from "@/lib/page/types";
import { requireSite } from "@/lib/site/request";
import { readChangePreview } from "@/lib/site/theme-preview";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isSafeId(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  const site = await requireSite(request, "site-theme");
  if (!site.ok) return site.response;
  const preview = await readChangePreview(site.siteId, id);
  return preview ? NextResponse.json(preview) : NextResponse.json({ error: "Preview not found" }, { status: 404 });
}
