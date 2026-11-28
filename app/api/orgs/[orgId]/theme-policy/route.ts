import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { planBlock, readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { NO_POLICY, parsePolicy, readOrgPolicy, saveOrgPolicy } from "@/lib/site/theme-policy";
import { ConfigError } from "@/lib/site/theme-config";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/** The organization's theme policy (#69): brand locks, allowed themes, signed-only and budget blocking. */
export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "theme-policy-read");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json(await readOrgPolicy(admin.orgId));
}

/**
 * Replaces the policy. Only an owner or admin can, and loosening or clearing it
 * is always allowed, even after a downgrade; setting a restriction needs the
 * enterprise plan on the hosted service.
 */
export async function PUT(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "theme-policy-set");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  let policy;
  try {
    policy = parsePolicy(body);
  } catch (error) {
    if (error instanceof ConfigError) return NextResponse.json({ error: error.message, path: error.path }, { status: 400 });
    throw error;
  }
  const restricts = JSON.stringify(policy) !== JSON.stringify(NO_POLICY);
  if (restricts) {
    const blocked = await planBlock(admin.orgId, "themeGovernance");
    if (blocked) return blocked;
  }
  await saveOrgPolicy(admin.orgId, policy, admin.sub);
  await auditRequest(request, {
    event: "org.theme_policy",
    outcome: "ok",
    status: 200,
    actorSub: admin.sub,
    pagePath: `${admin.orgId}:locks=${Object.keys(policy.lockedTokens).length},allowed=${policy.allowedThemes?.length ?? "any"},signed=${policy.requireSigned},budget=${policy.blockOnBudget}`,
  });
  return NextResponse.json(policy);
}
