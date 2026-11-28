import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { planBlock, readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { createRollout, listRollouts, RolloutError } from "@/lib/site/theme-rollout";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "theme-rollout-read");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ rollouts: await listRollouts(admin.orgId) });
}

/**
 * Plans a staged theme rollout (#69): `{ change, stages: [[siteId, ...], ...] }`,
 * where `change` is what `PUT /api/site/theme` takes. Nothing is applied yet;
 * the response says which sites would refuse the change (`problems`). Advance it
 * stage by stage with `POST .../theme-rollouts/{id}`.
 */
export async function POST(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "theme-rollout-create");
  if (admin instanceof NextResponse) return admin;
  const blocked = await planBlock(admin.orgId, "themeGovernance");
  if (blocked) return blocked;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const created = await createRollout(admin.orgId, body.change, body.stages, admin.sub);
    await auditRequest(request, { event: "org.theme_rollout", outcome: "ok", status: 201, actorSub: admin.sub, pagePath: `${admin.orgId}:${created.rollout.id}:planned` });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (error instanceof RolloutError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
