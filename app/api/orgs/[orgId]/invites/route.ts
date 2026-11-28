import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { memberErrorResponse, seatsChanged } from "@/lib/tenant/member-route";
import { inviteMember } from "@/lib/tenant/members";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/**
 * Invites an email address: `{ "email", "role" }`. Someone who has signed in
 * before joins at once (status "added"); anyone else is "pending" and joins at
 * their first Google sign-in with that address.
 */
export async function POST(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "org-invite");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const result = await inviteMember(admin.orgId, admin.role, body.email, body.role);
    if (result.status === "added") await seatsChanged(admin.orgId);
    await auditRequest(request, { event: "org.member.invited", outcome: "ok", status: 201, actorSub: admin.sub, pagePath: `${admin.orgId}:${result.role}:${result.status}` });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return memberErrorResponse(error);
  }
}
