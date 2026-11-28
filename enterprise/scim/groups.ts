import { query } from "@/lib/db/client";
import { ROLES, type Role } from "@/lib/tenant/orgs";
import { ScimError, GROUP_SCHEMA, LIST_SCHEMA } from "./errors";
import { asRole, getUserRow, setUserRole, type ScimUserRow } from "./users";

/**
 * SCIM Groups (#49), mapped to roles. There is one group per role (`owner`,
 * `admin`, `editor`, `viewer`) and a user is in the group of their role. An
 * identity provider's group named after a role (or `pagefirst-<role>`) pushes
 * its members into that role; leaving a group demotes to viewer, which is free.
 */

const baseUrl = () => (process.env.APP_URL?.trim().replace(/\/$/, "") ?? "") + "/api/scim/v2";

/** `Editors`-style names are not guessed: the name must be the role, optionally prefixed `pagefirst-`. */
export function roleForGroupName(name: unknown): Role {
  const role = typeof name === "string" ? asRole(name.trim().toLowerCase().replace(/^pagefirst[-_ ]/, "")) : null;
  if (!role) throw new ScimError(400, `Group displayName must be one of ${ROLES.join(", ")} (optionally prefixed "pagefirst-").`, "invalidValue");
  return role;
}

function roleForId(id: string): Role {
  const role = asRole(id);
  if (!role) throw new ScimError(404, "Group not found.");
  return role;
}

async function members(orgId: string, role: Role): Promise<ScimUserRow[]> {
  return query<ScimUserRow>(
    `SELECT id, org_id, user_name, external_id, display_name, given_name, family_name, active, role, sub, created_at, updated_at
       FROM scim_users WHERE org_id = $1 AND role = $2 AND active ORDER BY user_name`,
    [orgId, role],
  );
}

export async function groupResource(orgId: string, role: Role): Promise<object> {
  const list = await members(orgId, role);
  return {
    schemas: [GROUP_SCHEMA],
    id: role,
    displayName: role,
    members: list.map((u) => ({ value: u.id, display: u.user_name, $ref: `${baseUrl()}/Users/${u.id}` })),
    meta: { resourceType: "Group", location: `${baseUrl()}/Groups/${role}` },
  };
}

export async function getGroup(orgId: string, id: string): Promise<object> {
  return groupResource(orgId, roleForId(id));
}

export async function listGroups(orgId: string, params: URLSearchParams): Promise<object> {
  let roles: readonly Role[] = ROLES;
  const filter = params.get("filter");
  if (filter) {
    const m = /^\s*displayName\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
    if (!m) throw new ScimError(400, 'Only the filter displayName eq "value" is supported.', "invalidFilter");
    const role = asRole(m[1]!.trim().toLowerCase().replace(/^pagefirst[-_ ]/, ""));
    roles = role ? [role] : [];
  }
  const resources = await Promise.all(roles.map((r) => groupResource(orgId, r)));
  return { schemas: [LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources };
}

function memberIds(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ScimError(400, "members must be a list.", "invalidSyntax");
  return value.map((m) => {
    const id = typeof m === "object" && m !== null ? (m as { value?: unknown }).value : undefined;
    if (typeof id !== "string") throw new ScimError(400, "Each member needs a value (the user id).", "invalidSyntax");
    return id;
  });
}

async function addTo(orgId: string, role: Role, ids: string[]): Promise<void> {
  for (const id of ids) await setUserRole(orgId, (await getUserRow(orgId, id)).id, role);
}

/** Leaving a role group demotes to viewer. Leaving the viewer group changes nothing. */
async function removeFrom(orgId: string, role: Role, ids: string[]): Promise<void> {
  if (role === "viewer") return;
  for (const id of ids) {
    const row = await getUserRow(orgId, id);
    if (row.role === role) await setUserRole(orgId, row.id, "viewer");
  }
}

/** POST: the group for the role already exists, so this adds the listed members and returns it. */
export async function createGroup(orgId: string, body: unknown): Promise<object> {
  if (typeof body !== "object" || body === null) throw new ScimError(400, "Send a JSON Group object.", "invalidSyntax");
  const role = roleForGroupName((body as { displayName?: unknown }).displayName);
  await addTo(orgId, role, memberIds((body as { members?: unknown }).members));
  return groupResource(orgId, role);
}

async function replaceMembers(orgId: string, role: Role, ids: string[]): Promise<void> {
  const wanted = new Set(ids);
  const current = (await members(orgId, role)).map((u) => u.id).filter((id) => !wanted.has(id));
  await addTo(orgId, role, ids);
  await removeFrom(orgId, role, current);
}

export async function replaceGroup(orgId: string, id: string, body: unknown): Promise<object> {
  const role = roleForId(id);
  if (typeof body !== "object" || body === null) throw new ScimError(400, "Send a JSON Group object.", "invalidSyntax");
  await replaceMembers(orgId, role, memberIds((body as { members?: unknown }).members));
  return groupResource(orgId, role);
}

export async function patchGroup(orgId: string, id: string, body: unknown): Promise<object> {
  const role = roleForId(id);
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > 50) throw new ScimError(400, "Operations must be a list of 1 to 50 operations.", "invalidSyntax");
  for (const raw of ops as { op?: unknown; path?: unknown; value?: unknown }[]) {
    const op = typeof raw?.op === "string" ? raw.op.toLowerCase() : "";
    const path = typeof raw?.path === "string" ? raw.path : "";
    if (op === "remove" && /^members\[value eq "([^"]+)"\]$/i.test(path)) {
      await removeFrom(orgId, role, [/"([^"]+)"/.exec(path)![1]!]);
    } else if (/^members$/i.test(path) || (path === "" && typeof raw.value === "object" && raw.value !== null && "members" in (raw.value as object))) {
      const value = path ? raw.value : (raw.value as { members?: unknown }).members;
      if (op === "add") await addTo(orgId, role, memberIds(value));
      else if (op === "remove") await removeFrom(orgId, role, memberIds(value));
      else if (op === "replace") await replaceMembers(orgId, role, memberIds(value));
      else throw new ScimError(400, "op must be add, replace or remove.", "invalidSyntax");
    }
    // displayName and other group attributes are fixed by the role and ignored.
  }
  return groupResource(orgId, role);
}

export async function deleteGroup(orgId: string, id: string): Promise<void> {
  const role = roleForId(id);
  await removeFrom(orgId, role, (await members(orgId, role)).map((u) => u.id));
}
