import { NextResponse } from "next/server";
import { query } from "@/lib/db/client";
import { requireSite } from "@/lib/site/request";
import type { Role } from "@/lib/tenant/orgs";
import { DomainServiceError, type Actor } from "./service";

/**
 * The caller's site as a domain-service actor (#188). `requireSite` has already
 * checked the role; the service's ownership check uses the site's owner, so a
 * member of an organization acts on the organization's site.
 */
export async function requireDomainActor(
  request: Request,
  minimum: Role,
): Promise<{ ok: true; actor: Actor } | { ok: false; response: NextResponse }> {
  const site = await requireSite(request, "site-domains", minimum);
  if (!site.ok) return site;
  const [row] = await query<{ owner_sub: string }>("SELECT owner_sub FROM sites WHERE id = $1", [site.siteId]);
  if (!row) return { ok: false, response: NextResponse.json({ error: "Site not found" }, { status: 404 }) };
  return { ok: true, actor: { ownerSub: row.owner_sub, siteId: site.siteId } };
}

const STATUS: Record<DomainServiceError["code"], number> = {
  invalid: 400,
  limit: 402,
  taken: 409,
  not_found: 404,
  unavailable: 503,
  provider: 502,
};

export function domainErrorResponse(error: unknown): NextResponse {
  if (error instanceof DomainServiceError) return NextResponse.json({ error: error.message, code: error.code }, { status: STATUS[error.code] });
  throw error;
}
