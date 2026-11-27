import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { siteForOwner } from "@/lib/site/theme-config";
import { cancelInvite, changeMemberRole, inviteMember, isPersonalOrg, listOrgMembers, MemberError, removeOrgMember } from "./members";
import { claimPendingMemberships, createOrganization, personalOrgId, roleOf, seatCount } from "./orgs";

const url = testDatabaseUrl();

const denied = (status: number) => (error: unknown) => error instanceof MemberError && error.status === status;

describe("organization members and invites (#45)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgId = "";
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    await upsertUser("owner", "owner@example.com");
    await upsertUser("known", "Known@Example.com");
    orgId = (await createOrganization("owner", "Acme")).id;
  });
  after(async () => {
    await closeDatabase();
  });

  test("a person who has signed in joins at once; a stranger is pending and joins at first sign-in", async () => {
    assert.deepEqual(await inviteMember(orgId, "owner", " known@example.com ", "editor"), { status: "added", email: "known@example.com", role: "editor" });
    assert.equal(await roleOf(orgId, "known"), "editor");
    assert.equal(await seatCount(orgId), 2);

    assert.equal((await inviteMember(orgId, "owner", "New@Example.com", "viewer")).status, "pending");
    const listed = await listOrgMembers(orgId);
    assert.deepEqual(listed.pending.map((p) => [p.email, p.role]), [["new@example.com", "viewer"]]);
    assert.equal(listed.members.length, 2);

    await upsertUser("fresh", "new@example.com");
    assert.deepEqual(await claimPendingMemberships("fresh", "new@example.com", null), [orgId]);
    assert.equal(await roleOf(orgId, "fresh"), "viewer");
    assert.equal((await listOrgMembers(orgId)).pending.length, 0);
  });

  test("rejects bad input and duplicates", async () => {
    await assert.rejects(inviteMember(orgId, "owner", "not-an-email", "editor"), denied(400));
    await assert.rejects(inviteMember(orgId, "owner", "a@example.com", "god"), denied(400));
    await inviteMember(orgId, "owner", "known@example.com", "editor");
    await assert.rejects(inviteMember(orgId, "owner", "known@example.com", "viewer"), denied(409));
  });

  test("an admin manages members but cannot grant or touch the owner role; editors cannot manage at all", async () => {
    await assert.rejects(inviteMember(orgId, "admin", "x@example.com", "owner"), denied(403));
    await assert.rejects(inviteMember(orgId, "editor", "x@example.com", "viewer"), denied(403));
    await assert.rejects(changeMemberRole(orgId, "admin", "owner", "viewer"), denied(403));
    await assert.rejects(removeOrgMember(orgId, "admin", "owner"), denied(403));
    await assert.rejects(removeOrgMember(orgId, "viewer", "owner"), denied(403));
    assert.equal(await roleOf(orgId, "owner"), "owner");
  });

  test("an organization keeps at least one owner", async () => {
    await assert.rejects(changeMemberRole(orgId, "owner", "owner", "admin"), denied(409));
    await assert.rejects(removeOrgMember(orgId, "owner", "owner"), denied(409));
    await inviteMember(orgId, "owner", "known@example.com", "owner");
    assert.equal(await changeMemberRole(orgId, "owner", "owner", "admin"), "admin");
    await assert.rejects(removeOrgMember(orgId, "owner", "known"), denied(409), "the last owner stays");
    await removeOrgMember(orgId, "owner", "owner");
    assert.equal(await roleOf(orgId, "owner"), null);
  });

  test("changes roles, reports unknown members, and cancels invites", async () => {
    await inviteMember(orgId, "owner", "known@example.com", "viewer");
    assert.equal(await changeMemberRole(orgId, "admin", "known", "editor"), "editor");
    assert.equal(await seatCount(orgId), 2);
    await assert.rejects(changeMemberRole(orgId, "owner", "nobody", "editor"), denied(404));
    await inviteMember(orgId, "owner", "later@example.com", "editor");
    await cancelInvite(orgId, "admin", "LATER@example.com");
    await assert.rejects(cancelInvite(orgId, "owner", "later@example.com"), denied(404));
  });

  test("a personal organization takes no one else", async () => {
    await siteForOwner("owner");
    const personal = personalOrgId("owner");
    assert.equal(await isPersonalOrg(personal), true);
    assert.equal(await isPersonalOrg(orgId), false);
    await assert.rejects(inviteMember(personal, "owner", "known@example.com", "editor"), denied(409));
  });
});
