import { query } from "@/lib/db/client";
import { addMember, addPendingMember, removeMember, removePendingMember, ROLES, type Role } from "@/lib/tenant/orgs";
import { ScimError, LIST_SCHEMA, PATCH_SCHEMA, USER_SCHEMA } from "./errors";

/**
 * SCIM Users (#49). The identity provider is the source of truth for who is in
 * the organization and with what role. A user is a member (org_members) once
 * they have signed in with a matching verified Google account, and pending
 * (org_pending_members) until then. Deactivating or deleting removes access.
 */

export const DEFAULT_ROLE: Role = "editor";
const MAX_PAGE = 200;

export type ScimUserRow = {
  id: string;
  org_id: string;
  user_name: string;
  external_id: string | null;
  display_name: string | null;
  given_name: string | null;
  family_name: string | null;
  active: boolean;
  role: string;
  sub: string | null;
  created_at: Date;
  updated_at: Date;
};

const COLUMNS = "id, org_id, user_name, external_id, display_name, given_name, family_name, active, role, sub, created_at, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export const asRole = (value: unknown): Role | null => (typeof value === "string" && (ROLES as readonly string[]).includes(value.toLowerCase()) ? (value.toLowerCase() as Role) : null);

function baseUrl(): string {
  return (process.env.APP_URL?.trim().replace(/\/$/, "") ?? "") + "/api/scim/v2";
}

export function userResource(row: ScimUserRow): object {
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    name: { givenName: row.given_name ?? "", familyName: row.family_name ?? "" },
    displayName: row.display_name ?? row.user_name,
    emails: [{ value: row.user_name, type: "work", primary: true }],
    active: row.active,
    roles: [{ value: row.role, primary: true }],
    meta: { resourceType: "User", created: row.created_at.toISOString(), lastModified: row.updated_at.toISOString(), location: `${baseUrl()}/Users/${row.id}` },
  };
}

export async function getUserRow(orgId: string, id: string): Promise<ScimUserRow> {
  if (!UUID.test(id)) throw new ScimError(404, "User not found.");
  const rows = await query<ScimUserRow>(`SELECT ${COLUMNS} FROM scim_users WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!rows[0]) throw new ScimError(404, "User not found.");
  return rows[0];
}

type Fields = {
  userName?: string;
  externalId?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  active?: boolean;
  role?: Role;
};

const text = (v: unknown, max: number, field: string): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || v.length > max) throw new ScimError(400, `${field} must be text up to ${max} characters.`, "invalidValue");
  return v;
};

/** Entra sends booleans as the strings "True" and "False". */
function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  throw new ScimError(400, "active must be true or false.", "invalidValue");
}

function rolesFrom(value: unknown): Role | null | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  const raw = typeof first === "object" && first !== null ? (first as { value?: unknown }).value : first;
  if (raw === undefined || raw === null || raw === "") return null;
  const role = asRole(raw);
  if (!role) throw new ScimError(400, `roles must be one of ${ROLES.join(", ")}.`, "invalidValue");
  return role;
}

function normalizeUserName(value: unknown): string {
  if (typeof value !== "string" || !EMAIL.test(value.trim())) throw new ScimError(400, "userName must be the person's email address.", "invalidValue");
  return value.trim().toLowerCase();
}

/** Reads a full User body (POST and PUT). */
export function parseUser(body: unknown): Fields {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ScimError(400, "Send a JSON User object.", "invalidSyntax");
  const b = body as Record<string, unknown>;
  const name = (typeof b.name === "object" && b.name !== null ? b.name : {}) as Record<string, unknown>;
  const role = rolesFrom(b.roles);
  return {
    userName: normalizeUserName(b.userName),
    externalId: text(b.externalId, 255, "externalId"),
    displayName: text(b.displayName, 255, "displayName"),
    givenName: text(name.givenName, 120, "name.givenName"),
    familyName: text(name.familyName, 120, "name.familyName"),
    active: b.active === undefined ? true : asBoolean(b.active),
    ...(role ? { role } : {}),
  };
}

async function resolveSub(row: ScimUserRow): Promise<string | null> {
  if (row.sub) return row.sub;
  const rows = await query<{ sub: string }>("SELECT sub FROM users WHERE email = $1 LIMIT 1", [row.user_name]);
  const sub = rows[0]?.sub ?? null;
  if (sub) await query("UPDATE scim_users SET sub = $2 WHERE id = $1", [row.id, sub]);
  return sub;
}

async function ownerCount(orgId: string): Promise<number> {
  const rows = await query<{ n: string }>("SELECT count(*) AS n FROM org_members WHERE org_id = $1 AND role = 'owner'", [orgId]);
  return Number(rows[0]?.n ?? 0);
}

/** Makes org_members / org_pending_members match the row. */
export async function reconcile(row: ScimUserRow): Promise<void> {
  const sub = await resolveSub(row);
  if (!row.active) {
    if (sub) {
      try {
        await removeMember(row.org_id, sub);
      } catch {
        throw new ScimError(409, "The organization needs at least one owner, so this user cannot be removed.", "mutability");
      }
    }
    await removePendingMember(row.org_id, row.user_name);
    return;
  }
  const role = asRole(row.role) ?? DEFAULT_ROLE;
  if (sub) {
    const current = await query<{ role: string }>("SELECT role FROM org_members WHERE org_id = $1 AND sub = $2", [row.org_id, sub]);
    if (current[0]?.role === "owner" && role !== "owner" && (await ownerCount(row.org_id)) <= 1) {
      throw new ScimError(409, "The organization needs at least one owner, so this owner cannot be demoted.", "mutability");
    }
    await addMember(row.org_id, sub, role);
    await removePendingMember(row.org_id, row.user_name);
  } else {
    await addPendingMember(row.org_id, row.user_name, role, "scim");
  }
}

export async function createUser(orgId: string, body: unknown): Promise<ScimUserRow> {
  const f = parseUser(body);
  const exists = await query("SELECT 1 FROM scim_users WHERE org_id = $1 AND user_name = $2", [orgId, f.userName]);
  if (exists.length) throw new ScimError(409, "A user with that userName already exists.", "uniqueness");
  const rows = await query<ScimUserRow>(
    `INSERT INTO scim_users (org_id, user_name, external_id, display_name, given_name, family_name, active, role)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
    [orgId, f.userName, f.externalId ?? null, f.displayName ?? null, f.givenName ?? null, f.familyName ?? null, f.active ?? true, f.role ?? DEFAULT_ROLE],
  );
  try {
    await reconcile(rows[0]!);
  } catch (error) {
    await query("DELETE FROM scim_users WHERE id = $1", [rows[0]!.id]);
    throw error;
  }
  return rows[0]!;
}

async function save(row: ScimUserRow, f: Fields): Promise<ScimUserRow> {
  const next = {
    user_name: f.userName ?? row.user_name,
    external_id: f.externalId === undefined ? row.external_id : f.externalId,
    display_name: f.displayName === undefined ? row.display_name : f.displayName,
    given_name: f.givenName === undefined ? row.given_name : f.givenName,
    family_name: f.familyName === undefined ? row.family_name : f.familyName,
    active: f.active ?? row.active,
    role: f.role ?? row.role,
  };
  if (next.user_name !== row.user_name) {
    const taken = await query("SELECT 1 FROM scim_users WHERE org_id = $1 AND user_name = $2 AND id <> $3", [row.org_id, next.user_name, row.id]);
    if (taken.length) throw new ScimError(409, "A user with that userName already exists.", "uniqueness");
    // A changed email is a different Google account: drop the old membership first.
    await reconcile({ ...row, active: false });
  }
  const rows = await query<ScimUserRow>(
    `UPDATE scim_users SET user_name = $2, external_id = $3, display_name = $4, given_name = $5, family_name = $6, active = $7, role = $8,
            sub = CASE WHEN $2 = user_name THEN sub ELSE NULL END, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [row.id, next.user_name, next.external_id, next.display_name, next.given_name, next.family_name, next.active, next.role],
  );
  await reconcile(rows[0]!);
  return rows[0]!;
}

/** PUT: replaces the user's attributes. An omitted role keeps the current one. */
export async function replaceUser(orgId: string, id: string, body: unknown): Promise<ScimUserRow> {
  const row = await getUserRow(orgId, id);
  const f = parseUser(body);
  return save(row, { ...f, externalId: f.externalId ?? null, displayName: f.displayName ?? null, givenName: f.givenName ?? null, familyName: f.familyName ?? null });
}

export async function setUserRole(orgId: string, id: string, role: Role): Promise<ScimUserRow> {
  return save(await getUserRow(orgId, id), { role });
}

export async function deleteUser(orgId: string, id: string): Promise<void> {
  const row = await getUserRow(orgId, id);
  await reconcile({ ...row, active: false });
  await query("DELETE FROM scim_users WHERE id = $1", [id]);
}

type Operation = { op?: unknown; path?: unknown; value?: unknown };

function applyField(f: Fields, path: string, value: unknown, remove: boolean): void {
  switch (path.toLowerCase()) {
    case "active":
      f.active = remove ? false : asBoolean(value);
      break;
    case "username":
      f.userName = normalizeUserName(value);
      break;
    case "externalid":
      f.externalId = remove ? null : text(value, 255, "externalId");
      break;
    case "displayname":
      f.displayName = remove ? null : text(value, 255, "displayName");
      break;
    case "name.givenname":
      f.givenName = remove ? null : text(value, 120, "name.givenName");
      break;
    case "name.familyname":
      f.familyName = remove ? null : text(value, 120, "name.familyName");
      break;
    case "roles": {
      const role = remove ? null : rolesFrom(value);
      f.role = role ?? DEFAULT_ROLE;
      break;
    }
    default:
      // Attributes we do not store (emails, phone numbers, enterprise extension) are accepted and ignored,
      // because identity providers send them and fail the whole sync on an error.
      break;
  }
}

/** RFC 7644 section 3.5.2. */
export async function patchUser(orgId: string, id: string, body: unknown): Promise<ScimUserRow> {
  const row = await getUserRow(orgId, id);
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 50) throw new ScimError(400, "Operations must be a list of 1 to 50 operations.", "invalidSyntax");
  const f: Fields = {};
  for (const raw of ops as Operation[]) {
    const op = typeof raw?.op === "string" ? raw.op.toLowerCase() : "";
    if (!["add", "replace", "remove"].includes(op)) throw new ScimError(400, "op must be add, replace or remove.", "invalidSyntax");
    const remove = op === "remove";
    if (typeof raw.path === "string" && raw.path) {
      applyField(f, raw.path, raw.value, remove);
    } else if (typeof raw.value === "object" && raw.value !== null && !Array.isArray(raw.value)) {
      for (const [key, value] of Object.entries(raw.value as Record<string, unknown>)) {
        if (key.toLowerCase() === "name" && typeof value === "object" && value !== null) {
          for (const [k, v] of Object.entries(value)) applyField(f, `name.${k}`, v, remove);
        } else {
          applyField(f, key, value, remove);
        }
      }
    } else if (!remove) {
      throw new ScimError(400, "A pathless operation needs an object value.", "invalidSyntax");
    }
  }
  return save(row, f);
}

/** The only filters identity providers need: `userName eq "x"` and `externalId eq "x"`. */
function parseFilter(filter: string): { column: "user_name" | "external_id"; value: string } {
  const m = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  if (!m) throw new ScimError(400, 'Only filters of the form userName eq "value" or externalId eq "value" are supported.', "invalidFilter");
  const value = m[2]!.replace(/\\(.)/g, "$1");
  return m[1]!.toLowerCase() === "username" ? { column: "user_name", value: value.toLowerCase() } : { column: "external_id", value };
}

export async function listUsers(orgId: string, params: URLSearchParams): Promise<object> {
  const startIndex = Math.max(Number(params.get("startIndex")) || 1, 1);
  const count = Math.min(Math.max(params.get("count") === null ? 100 : Number(params.get("count")) || 0, 0), MAX_PAGE);
  const filter = params.get("filter");
  const where = ["org_id = $1"];
  const values: unknown[] = [orgId];
  if (filter) {
    const f = parseFilter(filter);
    values.push(f.value);
    where.push(`${f.column} = $${values.length}`);
  }
  const total = Number((await query<{ n: string }>(`SELECT count(*) AS n FROM scim_users WHERE ${where.join(" AND ")}`, values))[0]?.n ?? 0);
  const rows = count === 0 ? [] : await query<ScimUserRow>(
    `SELECT ${COLUMNS} FROM scim_users WHERE ${where.join(" AND ")} ORDER BY user_name LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
    [...values, count, startIndex - 1],
  );
  return { schemas: [LIST_SCHEMA], totalResults: total, startIndex, itemsPerPage: rows.length, Resources: rows.map(userResource) };
}

export { PATCH_SCHEMA };
