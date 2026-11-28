import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { accountDomain, planBlock, readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { getOrganization, normalizeDomain, setEnforcedDomain } from "@/lib/tenant/orgs";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, "domainLock", "domain-lock-read");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ domain: (await getOrganization(admin.orgId))?.enforcedDomain ?? null });
}

/**
 * Locks the organization to a Google Workspace domain, or clears the lock with
 * `{"domain": null}` (always allowed, even after a downgrade). Only an owner
 * can, and only while signed in from that domain, so the owner cannot lock
 * themselves out.
 */
export async function PUT(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "domain-lock-set", "owner");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  let domain: string | null = null;
  if (body.domain !== null) {
    domain = typeof body.domain === "string" ? normalizeDomain(body.domain) : null;
    if (!domain) return NextResponse.json({ error: "domain must be a domain like example.com, or null to clear the lock." }, { status: 400 });
    const blocked = await planBlock(admin.orgId, "domainLock");
    if (blocked) return blocked;
    if ((await accountDomain(admin.sub)) !== domain) {
      return NextResponse.json({ error: `Your Google account is not in the ${domain} Workspace, so this would lock you out. Sign in with an account from that domain.` }, { status: 400 });
    }
  }
  await setEnforcedDomain(admin.orgId, domain);
  await auditRequest(request, { event: "org.domain_lock", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: `${admin.orgId}:${domain ?? "cleared"}` });
  return NextResponse.json({ domain });
}
