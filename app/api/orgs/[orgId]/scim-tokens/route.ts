import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { createScimToken, listScimTokens, ScimTokenError } from "@/enterprise/scim/tokens";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/** The organization's SCIM tokens. Secrets are never returned here. */
export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, "scim", "scim-token-list");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ tokens: await listScimTokens(admin.orgId) });
}

/** Creates a token for an identity provider. The response is the only time the secret is shown. */
export async function POST(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, "scim", "scim-token-create");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const { token, record } = await createScimToken(admin.orgId, admin.sub, typeof body.label === "string" ? body.label : "");
    await auditRequest(request, { event: "org.scim_token.created", outcome: "ok", status: 201, actorSub: admin.sub, pagePath: admin.orgId, actorKey: record.prefix });
    return NextResponse.json({ token, record }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ScimTokenError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
