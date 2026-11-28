import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { siteForOwner } from "@/lib/site/theme-config";
import {
  addMember,
  canAccessSite,
  createOrganization,
  deleteOrganization,
  getOrganization,
  orgIdForSite,
  personalOrgId,
  planForSite,
  removeMember,
  listMemberships,
  requireFeature,
  roleOf,
  seatCount,
  setPlan,
  siteAllows,
} from "./orgs";
import { PlanError } from "./plans";
import { challengeFor } from "@/lib/oauth/protocol";
import { exchangeCode, issueCode, registerClient, verifyAccessToken } from "@/lib/oauth/store";
import { randomBytes } from "node:crypto";

const verifier = randomBytes(32).toString("base64url");

const url = testDatabaseUrl();

describe("organizations", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    await upsertUser("sub-a", "a@example.com");
    await upsertUser("sub-b", "b@example.com");
  });
  after(async () => {
    await closeDatabase();
    delete process.env.PAGEFIRST_EDITION;
  });

  test("a user's first site lands in their personal organization, on the free plan", async () => {
    const siteId = await siteForOwner("sub-a");
    assert.equal(await orgIdForSite(siteId), personalOrgId("sub-a"));
    assert.equal(await roleOf(personalOrgId("sub-a"), "sub-a"), "owner");
    assert.equal(await planForSite(siteId), "free");
    assert.equal(await siteForOwner("sub-a"), siteId, "still one site per owner");
  });

  test("one tenant cannot reach another tenant's site", async () => {
    const siteA = await siteForOwner("sub-a");
    const siteB = await siteForOwner("sub-b");
    assert.equal(await canAccessSite("sub-a", siteA), true);
    assert.equal(await canAccessSite("sub-b", siteA), false);
    assert.equal(await canAccessSite("sub-a", siteB), false);
    assert.equal(await canAccessSite("sub-a", "site_missing"), false);
  });

  test("roles are ordered: a viewer reads, an editor edits, an admin administers", async () => {
    const siteId = await siteForOwner("sub-a");
    const org = personalOrgId("sub-a");
    await addMember(org, "sub-b", "viewer");
    assert.equal(await canAccessSite("sub-b", siteId, "viewer"), true);
    assert.equal(await canAccessSite("sub-b", siteId, "editor"), false);
    await addMember(org, "sub-b", "editor");
    assert.equal(await canAccessSite("sub-b", siteId, "editor"), true);
    assert.equal(await canAccessSite("sub-b", siteId, "admin"), false);
  });

  test("an organization always keeps one owner", async () => {
    const org = await createOrganization("sub-a", "Acme");
    await assert.rejects(removeMember(org.id, "sub-a"), /at least one owner/);
    await addMember(org.id, "sub-b", "owner");
    assert.equal(await removeMember(org.id, "sub-a"), true);
    assert.equal(await removeMember(org.id, "sub-a"), false);
  });

  test("seats count editors and above, not viewers", async () => {
    const org = await createOrganization("sub-a", "Acme");
    assert.equal(await seatCount(org.id), 1);
    await addMember(org.id, "sub-b", "viewer");
    assert.equal(await seatCount(org.id), 1);
    await addMember(org.id, "sub-b", "editor");
    assert.equal(await seatCount(org.id), 2);
  });

  test("a free-plan site cannot use paid features when hosted, a paid one can, self-hosted always can", async () => {
    const siteId = await siteForOwner("sub-a");
    process.env.PAGEFIRST_EDITION = "hosted";
    assert.equal(await siteAllows(siteId, "customCss"), false);
    await assert.rejects(requireFeature(siteId, "customCss"), PlanError);
    await setPlan(personalOrgId("sub-a"), "pro");
    assert.equal(await siteAllows(siteId, "customCss"), true);
    await requireFeature(siteId, "templateOverrides");
    await setPlan(personalOrgId("sub-a"), "free");
    delete process.env.PAGEFIRST_EDITION;
    assert.equal(await siteAllows(siteId, "customCss"), true);
  });

  test("an unknown plan is refused", async () => {
    await assert.rejects(setPlan(personalOrgId("sub-a"), "platinum" as never), /Unknown plan/);
  });

  test("deleting an organization removes its sites and strands no credentials", async () => {
    const siteId = await siteForOwner("sub-a");
    const org = await createOrganization("sub-a", "Acme");
    await addMember(org.id, "sub-b", "editor");
    await query("INSERT INTO google_tokens (sub, refresh_token_sealed) VALUES ('sub-b', 'x')");
    await query(
      `INSERT INTO api_keys (sub, name, key_prefix, key_hash, scopes, expires_at) VALUES ('sub-b', 'k', 'pf_live_abcd', 'h', ARRAY['pages:read'], now() + interval '1 day')`,
    );
    const client = await registerClient("c", ["https://client.example/cb"]);
    const code = await issueCode({ clientId: client.clientId, sub: "sub-b", scopes: ["pages:read"], codeChallenge: challengeFor(verifier), redirectUri: "https://client.example/cb" });
    const exchanged = await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: "https://client.example/cb" });
    assert.ok(exchanged.ok);
    await deleteOrganization(org.id);
    if (exchanged.ok) assert.equal(await verifyAccessToken(exchanged.tokens.access_token), null, "OAuth tokens die with the tenant");
    assert.equal(await getOrganization(org.id), null);
    // sub-b belonged to no other organization, so their grant and keys go with it.
    assert.equal((await query("SELECT 1 FROM google_tokens WHERE sub = 'sub-b'")).length, 0);
    assert.equal((await query("SELECT 1 FROM api_keys WHERE sub = 'sub-b' AND revoked_at IS NULL")).length, 0);
    // sub-a keeps their personal organization, site and grant.
    assert.equal(await orgIdForSite(siteId), personalOrgId("sub-a"));
  });

  test("a deleted organization's sites are gone", async () => {
    const org = await createOrganization("sub-a", "Acme");
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ('site_x', 'sub-a', $1)", [org.id]);
    await deleteOrganization(org.id);
    assert.equal(await orgIdForSite("site_x"), null);
  });

  test("the migration backfills existing sites into personal organizations", async () => {
    await resetTestDatabase(url!);
    // Migrate to 12, add a legacy site, then apply 13 by hand.
    const { MIGRATIONS } = await import("@/lib/db/migrations");
    const { Client } = await import("pg");
    const client = new Client({ connectionString: url! });
    await client.connect();
    try {
      for (const m of MIGRATIONS.filter((m) => m.id < 13)) await client.query(m.sql);
      await client.query("INSERT INTO users (sub) VALUES ('legacy')");
      await client.query("INSERT INTO sites (id, owner_sub) VALUES ('site_old', 'legacy')");
      await client.query(MIGRATIONS.find((m) => m.id === 13)!.sql);
      const { rows } = await client.query("SELECT s.org_id, m.role FROM sites s JOIN org_members m ON m.org_id = s.org_id WHERE s.id = 'site_old'");
      assert.deepEqual(rows[0], { org_id: personalOrgId("legacy"), role: "owner" });
    } finally {
      await client.end();
    }
    await resetTestDatabase(url!);
  });

  test("memberships list the personal organization first, with role and sites, and never another tenant's", async () => {
    const siteA = await siteForOwner("sub-a");
    const team = await createOrganization("sub-b", "Team");
    await addMember(team.id, "sub-a", "editor");
    const memberships = await listMemberships("sub-a");
    assert.equal(memberships[0].org.id, personalOrgId("sub-a"));
    assert.deepEqual(memberships[0].siteIds, [siteA]);
    assert.deepEqual(memberships.map((m) => [m.org.id === team.id, m.role]).find(([isTeam]) => isTeam), [true, "editor"]);
    assert.ok(!memberships.some((m) => m.org.id === personalOrgId("sub-b")));
  });
});
