import { NextResponse } from "next/server";
import { readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { auditRequest } from "@/lib/audit-request";
import { closeOrganization } from "@/lib/tenant/offboard";
import { isPersonalOrg } from "@/lib/tenant/members";
import { getOrganization } from "@/lib/tenant/orgs";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/**
 * Closes an organization (#45): its published files, sites and data are deleted
 * and members' Google grants that nothing else needs are revoked. Owners only,
 * and the body must repeat the organization's name.
 */
export async function DELETE(request: Request, { params }: Params) {
  const { orgId } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "org-delete", "owner");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  const org = await getOrganization(orgId);
  if (!org) return NextResponse.json({ error: "Organization not found." }, { status: 404 });
  if (await isPersonalOrg(orgId)) return NextResponse.json({ error: "A personal organization can't be deleted." }, { status: 400 });
  if (body.confirm !== org.name) return NextResponse.json({ error: "Repeat the organization's name in `confirm` to delete it." }, { status: 400 });
  try {
    const removed = await closeOrganization(orgId);
    await auditRequest(request, { event: "org.deleted", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: orgId });
    return NextResponse.json({ deleted: true, ...removed });
  } catch (error) {
    console.error("organization delete failed", orgId, error instanceof Error ? error.name : "unknown");
    await auditRequest(request, { event: "org.deleted", outcome: "error", status: 502, actorSub: admin.sub, pagePath: orgId });
    return NextResponse.json({ error: "Could not remove the organization's published files. Nothing was deleted; try again." }, { status: 502 });
  }
}
