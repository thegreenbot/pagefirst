import { NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/admin/system";
import { auditRequest } from "@/lib/audit-request";
import { revokePublisher } from "@/lib/theme/publishers";

export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ slug: string }> }) {
  const admin = await requireSystemAdmin(request, "admin.theme-publishers");
  if (admin instanceof NextResponse) return admin;
  const { slug } = await context.params;
  if (!(await revokePublisher(slug))) return NextResponse.json({ error: "No active publisher with that scope." }, { status: 404 });
  await auditRequest(request, { event: "admin.theme_publisher", outcome: "ok", pagePath: `revoke:@${slug}`, actorSub: admin.sub });
  return NextResponse.json({ ok: true });
}
