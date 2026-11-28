import { NextResponse } from "next/server";
import { requireOrgAdmin } from "@/enterprise/admin";
import { query } from "@/lib/db/client";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ orgId: string }> };

/**
 * Every theme change across the organization's sites, and every change to its
 * theme policy: who, what, when (#69). Reads the audit log (#17); admins only.
 */
export async function GET(request: Request, { params }: Params) {
  const admin = await requireOrgAdmin(request, (await params).orgId, null, "theme-audit");
  if (admin instanceof NextResponse) return admin;
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit") ?? 50) || 50, 1), 200);
  const rows = await query<{ created_at: string; event: string; outcome: string; actor_sub: string | null; client: string; site_id: string | null; error_code: string | null; page_path: string | null }>(
    `SELECT created_at, event, outcome, actor_sub, client, site_id, error_code, page_path
       FROM audit_events
      WHERE (event IN ('site.theme.update', 'site.theme.preview', 'site.theme.apply', 'site.theme.discard')
             AND site_id IN (SELECT id FROM sites WHERE org_id = $1))
         OR (event = 'org.theme_policy' AND page_path LIKE $2)
      ORDER BY created_at DESC
      LIMIT $3`,
    [admin.orgId, `${admin.orgId}:%`, limit],
  );
  return NextResponse.json({
    events: rows.map((row) => ({
      at: row.created_at,
      event: row.event,
      outcome: row.outcome,
      actor: row.actor_sub,
      client: row.client,
      siteId: row.site_id,
      errorCode: row.error_code,
      ...(row.event === "org.theme_policy" ? { summary: row.page_path?.slice(admin.orgId.length + 1) ?? null } : {}),
    })),
  });
}
