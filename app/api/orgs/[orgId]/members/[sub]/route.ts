import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { memberErrorResponse, seatsChanged } from "@/lib/tenant/member-route";
import { changeMemberRole, removeOrgMember } from "@/lib/tenant/members";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string; sub: string }> };

/** Changes a member's role: `{ "role": "editor" }`. */
export async function PATCH(request: Request, { params }: Params) {
  const { orgId, sub } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "org-member-role");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const role = await changeMemberRole(admin.orgId, admin.role, sub, body.role);
    await seatsChanged(admin.orgId);
    await auditRequest(request, { event: "org.member.role_changed", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: `${admin.orgId}:${sub}:${role}` });
    return NextResponse.json({ sub, role });
  } catch (error) {
    return memberErrorResponse(error);
  }
}

/** Removes a member. An organization always keeps one owner. */
export async function DELETE(request: Request, { params }: Params) {
  const { orgId, sub } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "org-member-remove");
  if (admin instanceof NextResponse) return admin;
  try {
    await removeOrgMember(admin.orgId, admin.role, sub);
    await seatsChanged(admin.orgId);
    await auditRequest(request, { event: "org.member.removed", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: `${admin.orgId}:${sub}` });
    return NextResponse.json({ removed: true });
  } catch (error) {
    return memberErrorResponse(error);
  }
}
