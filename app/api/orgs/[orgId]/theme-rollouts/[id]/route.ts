import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { planBlock, readJsonBody, requireOrgAdmin } from "@/enterprise/admin";
import { isSafeId } from "@/lib/page/types";
import { advanceRollout, cancelRollout, readRollout, RolloutError } from "@/lib/site/theme-rollout";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string; id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { orgId, id } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "theme-rollout-read");
  if (admin instanceof NextResponse) return admin;
  const rollout = isSafeId(id) ? await readRollout(admin.orgId, id) : null;
  return rollout ? NextResponse.json(rollout) : NextResponse.json({ error: "Rollout not found" }, { status: 404 });
}

/**
 * `{ action: "advance" }` applies the next stage (on a halted rollout, retries the
 * stage's failed sites); `{ action: "cancel" }` stops it. Each site that changes
 * gets its own `site.theme.apply` audit entry, so the organization's theme audit
 * shows who changed which site.
 */
export async function POST(request: Request, { params }: Params) {
  const { orgId, id } = await params;
  const admin = await requireOrgAdmin(request, orgId, null, "theme-rollout-run");
  if (admin instanceof NextResponse) return admin;
  if (!isSafeId(id)) return NextResponse.json({ error: "Rollout not found" }, { status: 404 });
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    if (body.action === "cancel") {
      const rollout = await cancelRollout(admin.orgId, id);
      await auditRequest(request, { event: "org.theme_rollout", outcome: "ok", status: 200, actorSub: admin.sub, pagePath: `${admin.orgId}:${id}:cancelled` });
      return NextResponse.json(rollout);
    }
    if (body.action !== "advance") return NextResponse.json({ error: 'action must be "advance" or "cancel".' }, { status: 400 });
    const blocked = await planBlock(admin.orgId, "themeGovernance");
    if (blocked) return blocked;
    const before = (await readRollout(admin.orgId, id))?.results ?? {};
    const rollout = await advanceRollout(admin.orgId, id);
    for (const [siteId, result] of Object.entries(rollout.results)) {
      if (before[siteId]?.status === "applied" || !result) continue;
      await auditRequest(request, {
        event: "site.theme.apply",
        outcome: result.status === "applied" ? "ok" : "error",
        status: result.status === "applied" ? 200 : 400,
        errorCode: result.status === "applied" ? null : "rollout_refused",
        actorSub: admin.sub,
        siteId,
      });
    }
    await auditRequest(request, { event: "org.theme_rollout", outcome: rollout.status === "halted" ? "error" : "ok", status: 200, actorSub: admin.sub, pagePath: `${admin.orgId}:${id}:${rollout.status}` });
    return NextResponse.json(rollout);
  } catch (error) {
    if (error instanceof RolloutError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}
