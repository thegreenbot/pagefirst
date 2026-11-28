import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { requireOrgAdmin } from "@/enterprise/admin";
import { revokeScimToken } from "@/enterprise/scim/tokens";

export const dynamic = "force-dynamic";

/** Revokes a token; the identity provider's next request fails. */
export async function DELETE(request: Request, { params }: { params: Promise<{ orgId: string; tokenId: string }> }) {
  const { orgId, tokenId } = await params;
  const admin = await requireOrgAdmin(request, orgId, "scim", "scim-token-revoke");
  if (admin instanceof NextResponse) return admin;
  if (!(await revokeScimToken(admin.orgId, tokenId))) return NextResponse.json({ error: "Token not found." }, { status: 404 });
  await auditRequest(request, { event: "org.scim_token.revoked", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: admin.orgId, actorKey: tokenId });
  return NextResponse.json({ revoked: true });
}
