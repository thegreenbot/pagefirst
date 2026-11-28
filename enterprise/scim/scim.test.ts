import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { addMember, createOrganization, listPendingMembers, roleOf, setPlan, claimPendingMemberships } from "@/lib/tenant/orgs";
import { GET as listUsersRoute, POST as createUserRoute } from "@/app/api/scim/v2/Users/route";
import { DELETE as deleteUserRoute, PATCH as patchUserRoute } from "@/app/api/scim/v2/Users/[id]/route";
import { GET as listGroupsRoute } from "@/app/api/scim/v2/Groups/route";
import { PATCH as patchGroupRoute } from "@/app/api/scim/v2/Groups/[id]/route";
import { createScimToken, listScimTokens, revokeScimToken, verifyScimToken, MAX_ACTIVE_TOKENS } from "./tokens";

const url = testDatabaseUrl();
const BASE = "https://app.example/api/scim/v2";

describe("scim", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgId = "";
  let token = "";
  let tokenId = "";

  const call = (handler: (r: Request, c: never) => Promise<Response>, path: string, init: { method?: string; body?: unknown; token?: string | null; params?: object } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/scim+json" };
    const bearer = init.token === undefined ? token : init.token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const request = new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    return handler(request, { params: Promise.resolve(init.params ?? {}) } as never);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper over arbitrary JSON
  const json = async (r: Response) => (await r.json()) as Record<string, any>;

  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.APP_URL = "https://app.example";
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    await upsertUser("boss", "boss@corp.com", "corp.com");
    orgId = (await createOrganization("boss", "Corp")).id;
    ({ token, record: { id: tokenId } } = await createScimToken(orgId, "boss", "Okta"));
  });
  after(async () => {
    delete process.env.PAGEFIRST_EDITION;
    await closeDatabase();
  });

  test("tokens: shown once, verified by hash, revocable, capped", async () => {
    assert.match(token, /^pf_scim_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(await verifyScimToken(token), { tokenId, orgId });
    const listed = await listScimTokens(orgId);
    assert.equal(listed.length, 1);
    assert.ok(!JSON.stringify(listed).includes(token));
    assert.equal(await verifyScimToken("pf_scim_" + "x".repeat(43)), null);
    assert.equal(await revokeScimToken(orgId, tokenId), true);
    assert.equal(await verifyScimToken(token), null);
    for (let i = 0; i < MAX_ACTIVE_TOKENS; i++) await createScimToken(orgId, "boss", `t${i}`);
    await assert.rejects(createScimToken(orgId, "boss", "one too many"));
  });

  test("requests need a valid token and never cross organizations", async () => {
    assert.equal((await call(listUsersRoute as never, "/Users", { token: null })).status, 401);
    assert.equal((await call(listUsersRoute as never, "/Users", { token: "pf_scim_" + "y".repeat(43) })).status, 401);
    const other = (await createOrganization("boss", "Other")).id;
    const created = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "a@corp.com" } }));
    const { token: otherToken } = await createScimToken(other, "boss", "other");
    const seen = await json(await call(listUsersRoute as never, "/Users", { token: otherToken }));
    assert.equal(seen.totalResults, 0);
    const res = await call(deleteUserRoute as never, `/Users/${created.id}`, { method: "DELETE", token: otherToken, params: { id: created.id } });
    assert.equal(res.status, 404);
  });

  test("hosted: SCIM needs the enterprise plan", async () => {
    process.env.PAGEFIRST_EDITION = "hosted";
    try {
      assert.equal((await call(listUsersRoute as never, "/Users")).status, 403);
      await setPlan(orgId, "enterprise");
      assert.equal((await call(listUsersRoute as never, "/Users")).status, 200);
    } finally {
      delete process.env.PAGEFIRST_EDITION;
    }
  });

  test("creating a user who has not signed in makes a pending membership, claimed at sign-in", async () => {
    const res = await call(createUserRoute as never, "/Users", {
      method: "POST",
      body: { schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"], userName: "New@Corp.com", externalId: "ext-1", name: { givenName: "New", familyName: "Person" }, roles: [{ value: "admin" }] },
    });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("content-type"), "application/scim+json");
    const user = await json(res);
    assert.equal(user.userName, "new@corp.com");
    assert.equal(user.active, true);
    assert.deepEqual(user.roles, [{ value: "admin", primary: true }]);
    assert.deepEqual((await listPendingMembers(orgId)).map((p) => [p.email, p.role, p.source]), [["new@corp.com", "admin", "scim"]]);
    await upsertUser("newbie", "new@corp.com", "corp.com");
    await claimPendingMemberships("newbie", "new@corp.com", "corp.com");
    assert.equal(await roleOf(orgId, "newbie"), "admin");
  });

  test("a user who already has a Pagefirst account becomes a member immediately, as editor by default", async () => {
    await upsertUser("known", "known@corp.com", "corp.com");
    await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "known@corp.com" } });
    assert.equal(await roleOf(orgId, "known"), "editor");
  });

  test("duplicates and bad input are refused with SCIM errors", async () => {
    await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "dup@corp.com" } });
    const dup = await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "DUP@corp.com" } });
    assert.equal(dup.status, 409);
    assert.equal((await json(dup)).scimType, "uniqueness");
    const bad = await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "not-an-email" } });
    assert.equal(bad.status, 400);
    assert.deepEqual((await json(bad)).schemas, ["urn:ietf:params:scim:api:messages:2.0:Error"]);
    const role = await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "r@corp.com", roles: [{ value: "god" }] } });
    assert.equal(role.status, 400);
  });

  test("filtering by userName, and unsupported filters are rejected", async () => {
    await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "a@corp.com" } });
    await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "b@corp.com" } });
    const hit = await json(await call(listUsersRoute as never, `/Users?filter=${encodeURIComponent('userName eq "B@corp.com"')}`));
    assert.equal(hit.totalResults, 1);
    assert.equal(hit.Resources[0].userName, "b@corp.com");
    const all = await json(await call(listUsersRoute as never, "/Users?count=1&startIndex=2"));
    assert.equal(all.totalResults, 2);
    assert.equal(all.Resources.length, 1);
    assert.equal((await call(listUsersRoute as never, `/Users?filter=${encodeURIComponent('userName co "a"')}`)).status, 400);
  });

  test("deactivating (Okta and Entra styles) removes access; reactivating restores it", async () => {
    await upsertUser("leaver", "leaver@corp.com", "corp.com");
    const user = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "leaver@corp.com" } }));
    assert.equal(await roleOf(orgId, "leaver"), "editor");

    const okta = await call(patchUserRoute as never, `/Users/${user.id}`, { method: "PATCH", params: { id: user.id }, body: { Operations: [{ op: "replace", value: { active: false } }] } });
    assert.equal((await json(okta)).active, false);
    assert.equal(await roleOf(orgId, "leaver"), null);

    const entra = await call(patchUserRoute as never, `/Users/${user.id}`, { method: "PATCH", params: { id: user.id }, body: { Operations: [{ op: "Replace", path: "active", value: "True" }] } });
    assert.equal((await json(entra)).active, true);
    assert.equal(await roleOf(orgId, "leaver"), "editor");
  });

  test("deactivating a person who has not signed in withdraws the pending membership", async () => {
    const user = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "ghost@corp.com" } }));
    await call(patchUserRoute as never, `/Users/${user.id}`, { method: "PATCH", params: { id: user.id }, body: { Operations: [{ op: "replace", path: "active", value: false }] } });
    assert.deepEqual(await listPendingMembers(orgId), []);
  });

  test("DELETE removes the user and their access", async () => {
    await upsertUser("gone", "gone@corp.com", "corp.com");
    const user = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "gone@corp.com" } }));
    const res = await call(deleteUserRoute as never, `/Users/${user.id}`, { method: "DELETE", params: { id: user.id } });
    assert.equal(res.status, 204);
    assert.equal(await roleOf(orgId, "gone"), null);
    assert.equal((await json(await call(listUsersRoute as never, "/Users"))).totalResults, 0);
  });

  test("the last owner can't be removed or demoted by the identity provider", async () => {
    const user = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "boss@corp.com", roles: [{ value: "owner" }] } }));
    assert.equal(await roleOf(orgId, "boss"), "owner");
    const demote = await call(patchUserRoute as never, `/Users/${user.id}`, { method: "PATCH", params: { id: user.id }, body: { Operations: [{ op: "replace", path: "roles", value: [{ value: "viewer" }] }] } });
    assert.equal(demote.status, 409);
    const off = await call(patchUserRoute as never, `/Users/${user.id}`, { method: "PATCH", params: { id: user.id }, body: { Operations: [{ op: "replace", path: "active", value: false }] } });
    assert.equal(off.status, 409);
    assert.equal(await roleOf(orgId, "boss"), "owner");
  });

  test("groups map to roles: adding a member sets the role, removing demotes to viewer", async () => {
    await upsertUser("dev", "dev@corp.com", "corp.com");
    const user = await json(await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "dev@corp.com" } }));
    const groups = await json(await call(listGroupsRoute as never, "/Groups"));
    assert.deepEqual(groups.Resources.map((g: { id: string }) => g.id).sort(), ["admin", "editor", "owner", "viewer"]);
    assert.equal(groups.Resources.find((g: { id: string }) => g.id === "editor").members[0].value, user.id);

    await call(patchGroupRoute as never, "/Groups/admin", { method: "PATCH", params: { id: "admin" }, body: { Operations: [{ op: "add", path: "members", value: [{ value: user.id }] }] } });
    assert.equal(await roleOf(orgId, "dev"), "admin");
    await call(patchGroupRoute as never, "/Groups/admin", { method: "PATCH", params: { id: "admin" }, body: { Operations: [{ op: "remove", path: `members[value eq "${user.id}"]` }] } });
    assert.equal(await roleOf(orgId, "dev"), "viewer");
    const missing = await call(patchGroupRoute as never, "/Groups/wizard", { method: "PATCH", params: { id: "wizard" }, body: { Operations: [{ op: "add", path: "members", value: [] }] } });
    assert.equal(missing.status, 404);
  });

  test("provisioned members still lose access outside a locked domain", async () => {
    await upsertUser("personal", "p@corp.com", null);
    await call(createUserRoute as never, "/Users", { method: "POST", body: { userName: "p@corp.com" } });
    assert.equal(await roleOf(orgId, "personal"), "editor");
    await addMember(orgId, "personal", "editor");
    await query("UPDATE organizations SET enforced_domain = 'corp.com' WHERE id = $1", [orgId]);
    assert.equal(await roleOf(orgId, "personal"), null);
  });
});
