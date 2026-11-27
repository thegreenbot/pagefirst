import { query } from "@/lib/db/client";
import { addMember, addPendingMember, listPendingMembers, personalOrgId, removeMember, removePendingMember, ROLES, type PendingMember, type Role } from "./orgs";

/**
 * Managing who is in an organization (#45): list, invite by email, change a
 * role, remove. An owner can do all of it; an admin can manage editors and
 * viewers and other admins, but never touch an owner or grant that role.
 */

const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

export class MemberError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

export type OrgMember = { sub: string; email: string | null; role: Role; joinedAt: string };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** A personal organization belongs to one person; it takes no one else. */
export async function isPersonalOrg(orgId: string): Promise<boolean> {
  const owners = await query<{ sub: string }>("SELECT sub FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
  return owners.some((row) => personalOrgId(row.sub) === orgId);
}

export async function listOrgMembers(orgId: string): Promise<{ members: OrgMember[]; pending: PendingMember[] }> {
  const rows = await query<{ sub: string; email: string | null; role: string; created_at: Date }>(
    `SELECT m.sub, u.email, m.role, m.created_at FROM org_members m LEFT JOIN users u ON u.sub = m.sub
      WHERE m.org_id = $1 ORDER BY m.created_at, m.sub`,
    [orgId],
  );
  return {
    members: rows.map((row) => ({ sub: row.sub, email: row.email, role: row.role as Role, joinedAt: row.created_at.toISOString() })),
    pending: await listPendingMembers(orgId),
  };
}

function mayGrant(actor: Role, role: Role): void {
  if (RANK[actor] < RANK.admin) throw new MemberError("Only an owner or admin can manage members.", 403);
  if (role === "owner" && actor !== "owner") throw new MemberError("Only an owner can grant the owner role.", 403);
}

/**
 * Invites an email address. Someone who has already signed in joins at once;
 * anyone else is pending and joins at their first sign-in with that email.
 */
export async function inviteMember(orgId: string, actor: Role, email: unknown, role: unknown): Promise<{ status: "added" | "pending"; email: string; role: Role }> {
  if (typeof email !== "string" || !EMAIL.test(email.trim())) throw new MemberError("email must be an email address.", 400);
  if (!isRole(role)) throw new MemberError(`role must be one of ${ROLES.join(", ")}.`, 400);
  mayGrant(actor, role);
  if (await isPersonalOrg(orgId)) throw new MemberError("A personal organization cannot have other members. Create an organization first.", 409);
  const normalized = email.trim().toLowerCase();
  const known = await query<{ sub: string }>("SELECT sub FROM users WHERE lower(email) = $1 ORDER BY last_seen_at DESC LIMIT 1", [normalized]);
  if (known[0]) {
    const existing = await query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND sub = $2", [orgId, known[0].sub]);
    if (existing[0]) throw new MemberError("That person is already a member. Change their role instead.", 409);
    await addMember(orgId, known[0].sub, role);
    return { status: "added", email: normalized, role };
  }
  await addPendingMember(orgId, normalized, role);
  return { status: "pending", email: normalized, role };
}

export async function cancelInvite(orgId: string, actor: Role, email: string): Promise<void> {
  if (RANK[actor] < RANK.admin) throw new MemberError("Only an owner or admin can manage members.", 403);
  if (!(await removePendingMember(orgId, email))) throw new MemberError("No pending invite for that address.", 404);
}

async function targetRole(orgId: string, sub: string): Promise<Role> {
  const rows = await query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND sub = $2", [orgId, sub]);
  if (!rows[0]) throw new MemberError("Member not found.", 404);
  return rows[0].role as Role;
}

export async function changeMemberRole(orgId: string, actor: Role, sub: string, role: unknown): Promise<Role> {
  if (!isRole(role)) throw new MemberError(`role must be one of ${ROLES.join(", ")}.`, 400);
  mayGrant(actor, role);
  const current = await targetRole(orgId, sub);
  if (current === "owner" && actor !== "owner") throw new MemberError("Only an owner can change an owner's role.", 403);
  if (current === "owner" && role !== "owner") {
    const owners = await query<{ n: string }>("SELECT count(*) AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
    if (Number(owners[0]!.n) <= 1) throw new MemberError("An organization needs at least one owner.", 409);
  }
  await addMember(orgId, sub, role);
  return role;
}

export async function removeOrgMember(orgId: string, actor: Role, sub: string): Promise<void> {
  if (RANK[actor] < RANK.admin) throw new MemberError("Only an owner or admin can manage members.", 403);
  const current = await targetRole(orgId, sub);
  if (current === "owner" && actor !== "owner") throw new MemberError("Only an owner can remove an owner.", 403);
  try {
    await removeMember(orgId, sub);
  } catch (error) {
    throw new MemberError(error instanceof Error ? error.message : "Could not remove the member.", 409);
  }
}
