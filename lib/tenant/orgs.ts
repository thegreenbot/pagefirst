import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/lib/db/client";
import { revokeAllForUser } from "@/lib/oauth/store";
import { PlanError, featureAllowed, isPlan, type Feature, type Plan } from "./plans";

export const ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export type Organization = { id: string; name: string; plan: Plan; createdAt: string };

const asRole = (value: string): Role => (ROLES as readonly string[]).includes(value) ? (value as Role) : "viewer";

/** A user's personal organization id: stable, so it can be created in the same transaction as the first site. */
export function personalOrgId(sub: string): string {
  return `org_${createHash("md5").update(sub).digest("hex")}`;
}

/** Creates the user's personal organization and owner membership if missing. Call inside a transaction. */
export async function ensurePersonalOrg(client: Pick<PoolClient, "query">, sub: string): Promise<string> {
  const id = personalOrgId(sub);
  await client.query("INSERT INTO organizations (id, name) VALUES ($1, 'Personal') ON CONFLICT (id) DO NOTHING", [id]);
  await client.query("INSERT INTO org_members (org_id, sub, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING", [id, sub]);
  return id;
}

type OrgRow = { id: string; name: string; plan: string; created_at: Date };
const toOrganization = (row: OrgRow): Organization => ({ id: row.id, name: row.name, plan: isPlan(row.plan) ? row.plan : "free", createdAt: row.created_at.toISOString() });

export async function createOrganization(ownerSub: string, name: string): Promise<Organization> {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) throw new Error("An organization needs a name.");
  const id = `org_${randomBytes(9).toString("base64url")}`;
  return transaction(async (client) => {
    const { rows } = await client.query<OrgRow>("INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id, name, plan, created_at", [id, trimmed]);
    await client.query("INSERT INTO org_members (org_id, sub, role) VALUES ($1, $2, 'owner')", [id, ownerSub]);
    return toOrganization(rows[0]!);
  });
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const rows = await query<OrgRow>("SELECT id, name, plan, created_at FROM organizations WHERE id = $1", [id]);
  return rows[0] ? toOrganization(rows[0]) : null;
}

export async function orgIdForSite(siteId: string): Promise<string | null> {
  const rows = await query<{ org_id: string }>("SELECT org_id FROM sites WHERE id = $1", [siteId]);
  return rows[0]?.org_id ?? null;
}

export async function roleOf(orgId: string, sub: string): Promise<Role | null> {
  const rows = await query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND sub = $2", [orgId, sub]);
  return rows[0] ? asRole(rows[0].role) : null;
}

/** True when the user holds at least `minimum` in the organization that owns the site. A stranger always gets false. */
export async function canAccessSite(sub: string, siteId: string, minimum: Role = "viewer"): Promise<boolean> {
  const rows = await query<{ role: string }>(
    "SELECT m.role FROM sites s JOIN org_members m ON m.org_id = s.org_id WHERE s.id = $1 AND m.sub = $2",
    [siteId, sub],
  );
  return rows[0] ? RANK[asRole(rows[0].role)] >= RANK[minimum] : false;
}

export type Membership = { org: Organization; role: Role; siteIds: string[] };

/** The organizations a user belongs to with their role and sites, for the org switcher. Personal organization first. */
export async function listMemberships(sub: string): Promise<Membership[]> {
  const rows = await query<OrgRow & { role: string; site_ids: string[] | null }>(
    `SELECT o.id, o.name, o.plan, o.created_at, m.role,
            COALESCE(array_agg(s.id ORDER BY s.created_at) FILTER (WHERE s.id IS NOT NULL), '{}') AS site_ids
       FROM org_members m
       JOIN organizations o ON o.id = m.org_id
       LEFT JOIN sites s ON s.org_id = o.id
      WHERE m.sub = $1
      GROUP BY o.id, o.name, o.plan, o.created_at, m.role
      ORDER BY (o.id = $2) DESC, o.created_at`,
    [sub, personalOrgId(sub)],
  );
  return rows.map((row) => ({ org: toOrganization(row), role: asRole(row.role), siteIds: row.site_ids ?? [] }));
}

export async function addMember(orgId: string, sub: string, role: Role): Promise<void> {
  if (!ROLES.includes(role)) throw new Error("Unknown role.");
  await query("INSERT INTO users (sub) VALUES ($1) ON CONFLICT (sub) DO NOTHING", [sub]);
  await query(
    "INSERT INTO org_members (org_id, sub, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, sub) DO UPDATE SET role = EXCLUDED.role",
    [orgId, sub, role],
  );
}

/** Removes a member. An organization always keeps at least one owner. */
export async function removeMember(orgId: string, sub: string): Promise<boolean> {
  return transaction(async (client) => {
    const { rows } = await client.query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND sub = $2 FOR UPDATE", [orgId, sub]);
    if (!rows[0]) return false;
    if (rows[0].role === "owner") {
      const owners = await client.query<{ n: string }>("SELECT count(*) AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
      if (Number(owners.rows[0]?.n ?? 0) <= 1) throw new Error("An organization needs at least one owner.");
    }
    await client.query("DELETE FROM org_members WHERE org_id = $1 AND sub = $2", [orgId, sub]);
    return true;
  });
}

/** Editors and above: the people billing counts as seats. Viewers are free. */
export async function seatCount(orgId: string): Promise<number> {
  const rows = await query<{ n: string }>("SELECT count(*) AS n FROM org_members WHERE org_id = $1 AND role <> 'viewer'", [orgId]);
  return Number(rows[0]?.n ?? 0);
}

/** Set by billing (#47) or an operator, never by a customer-facing route. */
export async function setPlan(orgId: string, plan: Plan): Promise<void> {
  if (!isPlan(plan)) throw new Error("Unknown plan.");
  await query("UPDATE organizations SET plan = $2 WHERE id = $1", [orgId, plan]);
}

export async function planForSite(siteId: string): Promise<Plan> {
  const rows = await query<{ plan: string }>("SELECT o.plan FROM sites s JOIN organizations o ON o.id = s.org_id WHERE s.id = $1", [siteId]);
  return rows[0] && isPlan(rows[0].plan) ? rows[0].plan : "free";
}

/** Whether the site's organization may use a feature. Self-hosted installs always may. */
export async function siteAllows(siteId: string, feature: Feature): Promise<boolean> {
  return featureAllowed(await planForSite(siteId), feature);
}

/** Throws PlanError (402) when the site's plan does not include the feature. */
export async function requireFeature(siteId: string, feature: Feature): Promise<void> {
  if (!(await siteAllows(siteId, feature))) throw new PlanError(feature);
}

/**
 * Deletes an organization and everything it owns (cancellation). Google tokens
 * and API keys and OAuth tokens of members who belong to no other organization are
 * deleted too, so nothing can keep acting for a tenant that left.
 */
export async function deleteOrganization(orgId: string): Promise<void> {
  const orphans = await transaction(async (client) => {
    const { rows } = await client.query<{ sub: string }>(
      `SELECT m.sub FROM org_members m WHERE m.org_id = $1
       AND NOT EXISTS (SELECT 1 FROM org_members o WHERE o.sub = m.sub AND o.org_id <> $1)`,
      [orgId],
    );
    const orphans = rows.map((row) => row.sub);
    await client.query("DELETE FROM organizations WHERE id = $1", [orgId]);
    if (orphans.length > 0) {
      await client.query("UPDATE api_keys SET revoked_at = now() WHERE sub = ANY($1) AND revoked_at IS NULL", [orphans]);
      await client.query("DELETE FROM google_tokens WHERE sub = ANY($1)", [orphans]);
    }
    return orphans;
  });
  for (const sub of orphans) await revokeAllForUser(sub);
}
