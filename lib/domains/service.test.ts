import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { siteForOwner } from "@/lib/site/theme-config";
import { createFakeProvider } from "./fake-provider";
import { addSiteDomain, checkSiteDomain, DEFAULT_LIMITS, DomainServiceError, type Actor, type DomainDeps, listSiteDomains, removeSiteDomain, reverifyDomains } from "./service";
import { findHeldDomain } from "./store";

const url = testDatabaseUrl();
const ACTIVE = { state: "active" as const, message: null, records: [] };

function setup() {
  const provider = createFakeProvider();
  const hosts = new Map<string, string>();
  const canonical = new Map<string, string>();
  const deps: DomainDeps = {
    provider,
    hosts: {
      put: async (hostname, siteId) => void hosts.set(hostname, siteId),
      remove: async (hostname) => void hosts.delete(hostname),
      canonical: async (siteId, hostname) => void (hostname ? canonical.set(siteId, hostname) : canonical.delete(siteId)),
    },
    limits: { perSite: 2, perAccount: 3 },
  };
  return { provider, hosts, canonical, deps };
}

const refOf = (provider: ReturnType<typeof createFakeProvider>, hostname: string) => [...provider.states.keys()].find((ref) => ref.endsWith(`:${hostname}`))!;

describe("custom domain service", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let alice: Actor;
  let bob: Actor;

  before(async () => {
    await resetTestDatabase(url!);
    alice = { ownerSub: "alice-sub", siteId: await siteForOwner("alice-sub") };
    bob = { ownerSub: "bob-sub", siteId: await siteForOwner("bob-sub") };
  });
  after(async () => {
    await closeDatabase();
  });

  test("a new domain is pending, shows its records, and does not serve until the provider says active", async () => {
    const { provider, hosts, deps } = setup();
    const view = await addSiteDomain(alice, " WWW.Alice-site.com ", deps);
    assert.equal(view.domain.hostname, "www.alice-site.com");
    assert.equal(view.domain.status, "pending");
    assert.deepEqual(view.records.map((r) => r.type), ["CNAME"]);
    assert.equal(hosts.size, 0, "nothing serves before verification");

    provider.set(refOf(provider, "www.alice-site.com"), { state: "verifying", message: "Certificate pending" });
    const mid = await checkSiteDomain(alice, view.domain.id, deps);
    assert.equal(mid.domain.status, "verifying");
    assert.equal(hosts.size, 0);

    provider.set(refOf(provider, "www.alice-site.com"), ACTIVE);
    const done = await checkSiteDomain(alice, view.domain.id, deps);
    assert.equal(done.domain.status, "active");
    assert.ok(done.domain.verifiedAt);
    assert.deepEqual(done.records, []);
    assert.equal(hosts.get("www.alice-site.com"), alice.siteId);
    const [file] = await query<{ key: string }>("SELECT key FROM site_files WHERE site_id = $1 AND key = 'host:www.alice-site.com'", [alice.siteId]);
    assert.ok(file, "the host record is tracked so closing the organization removes it");
  });

  test("a provider that reports active at add time activates immediately", async () => {
    const { provider, hosts, deps } = setup();
    const orig = provider.add.bind(provider);
    provider.add = async (hostname, token) => ({ ...(await orig(hostname, token)), ...ACTIVE });
    const view = await addSiteDomain(alice, "docs.alice-site.com", deps);
    assert.equal(view.domain.status, "active");
    assert.equal(hosts.get("docs.alice-site.com"), alice.siteId);
  });

  test("another site cannot take a hostname that is held, and a failed claim leaves the first intact", async () => {
    const { hosts, deps } = setup();
    await assert.rejects(addSiteDomain(bob, "www.alice-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "taken");
    assert.equal((await findHeldDomain("www.alice-site.com"))?.siteId, alice.siteId);
    assert.equal(hosts.size, 0);
  });

  test("rejects bad input: publish domain, apex, junk, and missing provider", async () => {
    const { deps } = setup();
    process.env.PUBLISH_DOMAIN = "sites.pubdom.com";
    try {
      await assert.rejects(addSiteDomain(alice, "mine.sites.pubdom.com", deps), (e) => e instanceof DomainServiceError && e.code === "invalid");
    } finally {
      delete process.env.PUBLISH_DOMAIN;
    }
    await assert.rejects(addSiteDomain(alice, "alice-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "invalid" && e.message === "Bare domains aren't supported yet. Use a subdomain such as www.alice-site.com.");
    await assert.rejects(addSiteDomain(alice, "https://x.alice-site.com/a", deps), (e) => e instanceof DomainServiceError && e.code === "invalid");
    await assert.rejects(addSiteDomain(alice, "x.alice-site.com", { ...deps, provider: null }), (e) => e instanceof DomainServiceError && e.code === "unavailable");
  });

  test("enforces the per-site limit", async () => {
    const { deps } = setup();
    await assert.rejects(addSiteDomain(alice, "third.alice-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "limit");
    assert.equal(DEFAULT_LIMITS.perSite >= 1, true);
  });

  test("a provider failure frees the hostname so the owner can retry", async () => {
    const { provider, deps } = setup();
    provider.add = async () => {
      throw new Error("boom");
    };
    await assert.rejects(addSiteDomain(bob, "www.bob-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "provider");
    assert.equal(await findHeldDomain("www.bob-site.com"), null);
    const working = setup();
    assert.equal((await addSiteDomain(bob, "www.bob-site.com", working.deps)).domain.status, "pending");
  });

  test("a domain that stops validating stops serving, and can come back", async () => {
    const { provider, hosts, deps } = setup();
    const view = await addSiteDomain(alice, "docs.alice-site.com", { ...deps, limits: { perSite: 9, perAccount: 9 } }).catch(async (error) => {
      // Already held from an earlier test: look it up instead.
      assert.ok(error instanceof DomainServiceError && error.code === "taken");
      const [held] = (await listSiteDomains(alice)).filter((d) => d.hostname === "docs.alice-site.com");
      return { domain: held! };
    });
    const id = view.domain.id;
    // Seed the fake with this hostname, active, and a live host record.
    const ref = (await provider.add("docs.alice-site.com", "t")).ref;
    await query("UPDATE site_domains SET provider_ref = $2, status = 'active' WHERE id = $1", [id, ref]);
    hosts.set("docs.alice-site.com", alice.siteId);

    provider.set(ref, { state: "error", message: "CNAME no longer points here", records: [] });
    const sweep = await reverifyDomains(deps);
    assert.ok(sweep.checked >= 1);
    assert.equal(hosts.has("docs.alice-site.com"), false, "an unvalidated hostname stops serving");
    assert.equal((await findHeldDomain("docs.alice-site.com"))?.status, "error");
    assert.equal((await findHeldDomain("docs.alice-site.com"))?.lastError, "CNAME no longer points here");

    provider.set(ref, ACTIVE);
    await reverifyDomains(deps);
    assert.equal(hosts.get("docs.alice-site.com"), alice.siteId);
    assert.equal((await findHeldDomain("docs.alice-site.com"))?.status, "active");
  });

  test("only the owner can check or remove a domain", async () => {
    const { deps } = setup();
    const [domain] = await listSiteDomains(alice);
    await assert.rejects(checkSiteDomain(bob, domain!.id, deps), (e) => e instanceof DomainServiceError && e.code === "not_found");
    await assert.rejects(removeSiteDomain(bob, domain!.id, deps), (e) => e instanceof DomainServiceError && e.code === "not_found");
    await assert.rejects(removeSiteDomain({ ownerSub: "bob-sub", siteId: alice.siteId }, domain!.id, deps), (e) => e instanceof DomainServiceError && e.code === "not_found");
  });

  test("removing stops serving first, drops the provider record, frees the hostname and is audited", async () => {
    const { provider, hosts, canonical, deps } = setup();
    const view = await addSiteDomain(bob, "shop.bob-site.com", deps);
    provider.set(refOf(provider, "shop.bob-site.com"), ACTIVE);
    await checkSiteDomain(bob, view.domain.id, deps);
    assert.equal(hosts.has("shop.bob-site.com"), true);
    assert.equal(canonical.get(bob.siteId), "shop.bob-site.com", "the site's other addresses redirect to its active domain");

    await removeSiteDomain(bob, view.domain.id, deps);
    assert.equal(hosts.has("shop.bob-site.com"), false);
    assert.equal(canonical.has(bob.siteId), false, "no redirect is left pointing at a removed host");
    assert.equal(provider.removed.length, 1);
    assert.equal(await findHeldDomain("shop.bob-site.com"), null);
    const events = await query<{ event: string; page_path: string }>("SELECT event, page_path FROM audit_events WHERE page_path = 'shop.bob-site.com' ORDER BY at, id");
    assert.deepEqual(events.map((e) => e.event), ["site.domain.added", "site.domain.activated", "site.domain.removed"]);
    const [file] = await query("SELECT 1 FROM site_files WHERE site_id = $1 AND key = 'host:shop.bob-site.com'", [bob.siteId]);
    assert.equal(file, undefined);
  });

  test("if the provider can't remove, serving has already stopped and the owner can retry", async () => {
    const { provider, hosts, deps } = setup();
    const view = await addSiteDomain(bob, "blog.bob-site.com", deps);
    provider.set(refOf(provider, "blog.bob-site.com"), ACTIVE);
    await checkSiteDomain(bob, view.domain.id, deps);
    const realRemove = provider.remove.bind(provider);
    provider.remove = async () => {
      throw new Error("provider down");
    };
    await assert.rejects(removeSiteDomain(bob, view.domain.id, deps), (e) => e instanceof DomainServiceError && e.code === "provider");
    assert.equal(hosts.has("blog.bob-site.com"), false);
    assert.equal((await findHeldDomain("blog.bob-site.com"))?.status, "error");
    provider.remove = realRemove;
    await removeSiteDomain(bob, view.domain.id, deps);
    assert.equal(await findHeldDomain("blog.bob-site.com"), null);
  });
});
