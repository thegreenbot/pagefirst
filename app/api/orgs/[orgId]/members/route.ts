import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/enterprise/admin";
import { listOrgMembers } from "@/lib/tenant/members";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/** The organization's members and pending invites. Owners and admins only. */
export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "org-members-list");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ ...(await listOrgMembers(admin.orgId)), yourRole: admin.role });
}
