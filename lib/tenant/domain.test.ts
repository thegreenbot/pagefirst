import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import {
  addMember,
  addPendingMember,
  canAccessSite,
  claimPendingMemberships,
  createOrganization,
  getOrganization,
  listMemberships,
  listPendingMembers,
  normalizeDomain,
  removePendingMember,
  roleOf,
  setEnforcedDomain,
} from "./orgs";

const url = testDatabaseUrl();

test("normalizeDomain accepts domains and rejects everything else", () => {
  assert.equal(normalizeDomain(" Example.COM "), "example.com");
  assert.equal(normalizeDomain("sub.example.co.uk"), "sub.example.co.uk");
  for (const bad of ["", "example", "a@b.com", "http://example.com", "exa mple.com", "-x.com", "x..com"]) assert.equal(normalizeDomain(bad), null, bad);
});

describe("domain lock and pending memberships", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgId = "";
  before(async () => {
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    await upsertUser("boss", "boss@corp.com", "corp.com");
    await upsertUser("worker", "worker@corp.com", "corp.com");
    await upsertUser("outsider", "out@corp.com", null); // an @corp.com email on a personal Google account
    orgId = (await createOrganization("boss", "Corp")).id;
    await addMember(orgId, "worker", "editor");
    await addMember(orgId, "outsider", "editor");
  });
  after(closeDatabase);

  test("without a lock, everyone with a role has access", async () => {
    assert.equal(await roleOf(orgId, "outsider"), "editor");
  });

  test("a lock removes access from accounts outside the Workspace domain, even with a matching email", async () => {
    await setEnforcedDomain(orgId, "Corp.com");
    assert.equal((await getOrganization(orgId))?.enforcedDomain, "corp.com");
    assert.equal(await roleOf(orgId, "worker"), "editor");
    assert.equal(await roleOf(orgId, "outsider"), null);
    assert.ok(!(await listMemberships("outsider")).some((m) => m.org.id === orgId));
    assert.ok((await listMemberships("worker")).some((m) => m.org.id === orgId));
  });

  test("the lock also gates site access, and clearing it restores access", async () => {
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ('site_corp', 'boss', $1)", [orgId]);
    const siteId = "site_corp";
    await setEnforcedDomain(orgId, "corp.com");
    assert.equal(await canAccessSite("outsider", siteId), false);
    assert.equal(await canAccessSite("worker", siteId), true);
    await setEnforcedDomain(orgId, null);
    assert.equal(await canAccessSite("outsider", siteId), true);
  });

  test("a bad domain is refused and changes nothing", async () => {
    await assert.rejects(setEnforcedDomain(orgId, "not a domain"));
    assert.equal((await getOrganization(orgId))?.enforcedDomain, null);
  });

  test("hd is recorded at sign-in and left alone when not supplied", async () => {
    await upsertUser("worker", "worker@corp.com");
    assert.equal((await query<{ hd: string | null }>("SELECT hd FROM users WHERE sub = 'worker'"))[0].hd, "corp.com");
    await upsertUser("worker", "worker@corp.com", null);
    assert.equal((await query<{ hd: string | null }>("SELECT hd FROM users WHERE sub = 'worker'"))[0].hd, null);
  });

  test("a pending membership is claimed at sign-in by a matching verified email", async () => {
    await addPendingMember(orgId, "New.Person@Corp.com", "admin", "scim");
    assert.deepEqual((await listPendingMembers(orgId)).map((p) => [p.email, p.role, p.source]), [["new.person@corp.com", "admin", "scim"]]);
    await upsertUser("newbie", "new.person@corp.com", "corp.com");
    assert.deepEqual(await claimPendingMemberships("newbie", "New.Person@corp.com", "corp.com"), [orgId]);
    assert.equal(await roleOf(orgId, "newbie"), "admin");
    assert.deepEqual(await listPendingMembers(orgId), []);
  });

  test("a locked organization leaves a pending membership unclaimed for an account outside its domain", async () => {
    await setEnforcedDomain(orgId, "corp.com");
    await addPendingMember(orgId, "imposter@corp.com", "owner");
    await upsertUser("imposter", "imposter@corp.com", null);
    assert.deepEqual(await claimPendingMemberships("imposter", "imposter@corp.com", null), []);
    assert.equal(await roleOf(orgId, "imposter"), null);
    assert.equal((await listPendingMembers(orgId)).length, 1);
  });

  test("a pending membership can be withdrawn, and a pending role is replaced", async () => {
    await addPendingMember(orgId, "x@corp.com", "viewer");
    await addPendingMember(orgId, "x@corp.com", "editor");
    assert.deepEqual((await listPendingMembers(orgId)).map((p) => p.role), ["editor"]);
    assert.equal(await removePendingMember(orgId, "X@corp.com"), true);
    assert.equal(await removePendingMember(orgId, "x@corp.com"), false);
  });
});
