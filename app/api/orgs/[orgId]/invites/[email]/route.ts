import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { requireOrgAdmin } from "@/enterprise/admin";
import { memberErrorResponse } from "@/lib/tenant/member-route";
import { cancelInvite } from "@/lib/tenant/members";

export const dynamic = "force-dynamic";

/** Cancels a pending invite (the email is URL-encoded). */
export async function DELETE(request: Request, { params }: { params: Promise<{ orgId: string; email: string }> }) {
  const { orgId, email } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "org-invite-cancel");
  if (admin instanceof NextResponse) return admin;
  try {
    let address: string;
    try {
      address = decodeURIComponent(email);
    } catch {
      return NextResponse.json({ error: "Invalid email." }, { status: 400 });
    }
    await cancelInvite(admin.orgId, admin.role, address);
    await auditRequest(request, { event: "org.invite.cancelled", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: admin.orgId });
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    return memberErrorResponse(error);
  }
}
