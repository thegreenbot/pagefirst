import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { siteForOwner } from "@/lib/site/theme-config";
import { countDomains, createDomain, DomainError, findHeldDomain, listDomains, removeDomain, setDomainStatus } from "./store";

const url = testDatabaseUrl();

describe("site domains", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let aliceSite: string;
  let bobSite: string;

  before(async () => {
    await resetTestDatabase(url!);
    aliceSite = await siteForOwner("alice-sub");
    bobSite = await siteForOwner("bob-sub");
  });
  after(async () => {
    await closeDatabase();
  });

  test("creates a pending domain with a verification token, listed for its owner", async () => {
    const domain = await createDomain("alice-sub", aliceSite, "www.alice.example");
    assert.equal(domain.status, "pending");
    assert.equal(domain.hostname, "www.alice.example");
    assert.match(domain.verificationToken, /^[0-9a-f]{48}$/);
    const listed = await listDomains("alice-sub", aliceSite);
    assert.deepEqual(listed.map((d) => d.id), [domain.id]);
    assert.equal((await findHeldDomain("www.alice.example"))?.id, domain.id);
  });

  test("a second site cannot take a hostname another site holds", async () => {
    await assert.rejects(createDomain("bob-sub", bobSite, "www.alice.example"), (e) => e instanceof DomainError && e.code === "taken");
    await assert.rejects(createDomain("alice-sub", aliceSite, "www.alice.example"), (e) => e instanceof DomainError && e.code === "taken");
  });

  test("only the site's owner can add, list, count or remove", async () => {
    const [held] = await listDomains("alice-sub", aliceSite);
    await assert.rejects(createDomain("bob-sub", aliceSite, "x.alice.example"), (e) => e instanceof DomainError && e.code === "not_found");
    await assert.rejects(listDomains("bob-sub", aliceSite), (e) => e instanceof DomainError && e.code === "not_found");
    await assert.rejects(countDomains("bob-sub", aliceSite), (e) => e instanceof DomainError && e.code === "not_found");
    await assert.rejects(removeDomain("bob-sub", aliceSite, held!.id), (e) => e instanceof DomainError && e.code === "not_found");
    await assert.rejects(removeDomain("bob-sub", bobSite, held!.id), (e) => e instanceof DomainError && e.code === "not_found");
    assert.equal((await findHeldDomain("www.alice.example"))?.status, "pending");
  });

  test("status moves through the lifecycle and stamps verified_at once", async () => {
    const domain = await createDomain("alice-sub", aliceSite, "docs.alice.example");
    assert.equal((await setDomainStatus(domain.id, "verifying", { providerRef: "cf-1" }))?.providerRef, "cf-1");
    const failed = await setDomainStatus(domain.id, "error", { error: "CNAME missing" });
    assert.equal(failed?.lastError, "CNAME missing");
    const active = await setDomainStatus(domain.id, "active");
    assert.equal(active?.status, "active");
    assert.equal(active?.lastError, null);
    assert.equal(active?.providerRef, "cf-1", "the provider reference is kept");
    assert.ok(active?.verifiedAt);
    const again = await setDomainStatus(domain.id, "active");
    assert.equal(again?.verifiedAt, active?.verifiedAt);
  });

  test("counts only domains that are not removed, per site and per account", async () => {
    assert.deepEqual(await countDomains("alice-sub", aliceSite), { site: 2, account: 2 });
    assert.deepEqual(await countDomains("bob-sub", bobSite), { site: 0, account: 0 });
  });

  test("removing frees the hostname for another site and cannot be revived", async () => {
    const held = (await listDomains("alice-sub", aliceSite)).find((d) => d.hostname === "www.alice.example")!;
    const removed = await removeDomain("alice-sub", aliceSite, held.id);
    assert.equal(removed.status, "removed");
    assert.ok(removed.removedAt);
    assert.equal(await findHeldDomain("www.alice.example"), null);
    assert.equal(await setDomainStatus(held.id, "active"), null);
    await assert.rejects(removeDomain("alice-sub", aliceSite, held.id), (e) => e instanceof DomainError && e.code === "not_found");
    const taken = await createDomain("bob-sub", bobSite, "www.alice.example");
    assert.equal(taken.siteId, bobSite);
    const rows = await query<{ n: string }>("SELECT count(*) AS n FROM site_domains WHERE hostname = 'www.alice.example'");
    assert.equal(rows[0]!.n, "2", "the removed row is kept as history");
  });

  test("deleting a site removes its domains", async () => {
    await query("DELETE FROM sites WHERE id = $1", [bobSite]);
    assert.equal(await findHeldDomain("www.alice.example"), null);
  });
});
