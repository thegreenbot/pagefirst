import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { siteForOwner } from "@/lib/site/theme-config";
import { createFakeProvider } from "./fake-provider";
import { addSiteDomain, checkSiteDomain, DEFAULT_LIMITS, disableHostname, removeAllSiteDomains, sweepOrphans, transferSiteDomain, DomainServiceError, type Actor, type DomainDeps, listSiteDomains, removeSiteDomain, reverifyDomains } from "./service";
import { PlanError } from "@/lib/tenant/plans";
import { findHeldDomain, unblockHostname } from "./store";

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
      list: async () => [...hosts.keys()],
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

async function fresh(sub: string): Promise<Actor> {
    return { ownerSub: sub, siteId: await siteForOwner(sub) };
  }

  test("an operator can disable a hostname: it stops serving, can't be added again, and the provider record goes", async () => {
    const { provider, hosts, deps } = setup();
    const erin = await fresh("erin-sub");
    const view = await addSiteDomain(erin, "promo.evil-site.com", deps);
    provider.set(refOf(provider, "promo.evil-site.com"), ACTIVE);
    await checkSiteDomain(erin, view.domain.id, deps);
    assert.equal(hosts.has("promo.evil-site.com"), true);

    assert.equal(await disableHostname("evil-site.com", "phishing report", deps), 1);
    assert.equal(hosts.has("promo.evil-site.com"), false);
    assert.equal(provider.removed.length, 1);
    assert.equal((await findHeldDomain("promo.evil-site.com"))?.status, "error");
    await assert.rejects(addSiteDomain(await fresh("erin2-sub"), "www.evil-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "invalid");
    // Even if the provider still says active, a blocked hostname doesn't come back.
    const again = await checkSiteDomain(erin, view.domain.id, deps);
    assert.equal(again.domain.status, "error");
    assert.equal(hosts.has("promo.evil-site.com"), false);
    await removeSiteDomain(erin, view.domain.id, deps);
    await unblockHostname("evil-site.com");
  });

  test("deleting a site removes its domains first: serving stops and the provider hostnames go", async () => {
    const { provider, hosts, canonical, deps } = setup();
    const frank = await fresh("frank-sub");
    const view = await addSiteDomain(frank, "gone.bob-site.com", deps);
    provider.set(refOf(provider, "gone.bob-site.com"), ACTIVE);
    await checkSiteDomain(frank, view.domain.id, deps);
    assert.equal(canonical.get(frank.siteId), "gone.bob-site.com");

    assert.equal(await removeAllSiteDomains(frank.siteId, deps), 1);
    assert.equal(hosts.has("gone.bob-site.com"), false);
    assert.equal(canonical.has(frank.siteId), false);
    assert.equal(provider.removed.length, 1);
    assert.equal(await findHeldDomain("gone.bob-site.com"), null);
  });

  test("a domain moves between the owner's sites without ever being free, and serves again once verified", async () => {
    const { provider, hosts, deps } = setup();
    const gina = await fresh("gina-sub");
    await query("INSERT INTO sites (id, owner_sub, org_id) SELECT 'gina-second', owner_sub, org_id FROM sites WHERE id = $1", [gina.siteId]);
    const view = await addSiteDomain(gina, "move.alice-site.com", deps);
    provider.set(refOf(provider, "move.alice-site.com"), ACTIVE);
    await checkSiteDomain(gina, view.domain.id, deps);
    assert.equal(hosts.get("move.alice-site.com"), gina.siteId);

    provider.set(refOf(provider, "move.alice-site.com"), { state: "verifying", message: null });
    const moved = await transferSiteDomain(gina, view.domain.id, "gina-second", deps);
    assert.equal(moved.domain.siteId, "gina-second");
    assert.equal(hosts.has("move.alice-site.com"), false, "not serving until it is verified for the new site");
    assert.equal((await findHeldDomain("move.alice-site.com"))?.siteId, "gina-second", "still held, so nobody else can claim it");
    await assert.rejects(addSiteDomain(await fresh("gina2-sub"), "move.alice-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "taken");

    provider.set(refOf(provider, "move.alice-site.com"), ACTIVE);
    await checkSiteDomain({ ownerSub: gina.ownerSub, siteId: "gina-second" }, view.domain.id, deps);
    assert.equal(hosts.get("move.alice-site.com"), "gina-second");
    await assert.rejects(transferSiteDomain(await fresh("gina2-sub"), view.domain.id, "gina-second", deps), DomainServiceError, "only its owner can move it");
  });

  test("the sweeper removes host records and provider hostnames that nothing holds", async () => {
    const { provider, hosts, deps } = setup();
    const hank = await fresh("hank-sub");
    const view = await addSiteDomain(hank, "keep.alice-site.com", deps);
    provider.set(refOf(provider, "keep.alice-site.com"), ACTIVE);
    await checkSiteDomain(hank, view.domain.id, deps);
    hosts.set("orphan.alice-site.com", hank.siteId);
    await provider.add("orphan.alice-site.com", "token");

    assert.deepEqual(await sweepOrphans(deps), { hosts: 1, provider: 1 });
    assert.equal(hosts.has("orphan.alice-site.com"), false);
    assert.equal(hosts.has("keep.alice-site.com"), true, "a held domain is left alone");
    assert.equal(provider.states.size, 1);
  });

  {
    const setPlan = (siteId: string, plan: string) => query("UPDATE organizations SET plan = $2 WHERE id = (SELECT org_id FROM sites WHERE id = $1)", [siteId, plan]);
    const hosted = async (run: () => Promise<void>) => {
      process.env.PAGEFIRST_EDITION = "hosted";
      try {
        await run();
      } finally {
        delete process.env.PAGEFIRST_EDITION;
      }
    };

    test("a free site can't add a domain; a paid site can, up to its limit", () => hosted(async () => {
      const { deps } = setup();
      const carol = { ownerSub: "carol-sub", siteId: await siteForOwner("carol-sub") };
      await setPlan(carol.siteId, "free");
      await assert.rejects(addSiteDomain(carol, "www.carol-site.com", deps), (e) => e instanceof PlanError && e.feature === "customDomains");
      await setPlan(carol.siteId, "pro");
      await addSiteDomain(carol, "www.carol-site.com", deps);
      await addSiteDomain(carol, "blog.carol-site.com", deps);
      await assert.rejects(addSiteDomain(carol, "shop.carol-site.com", deps), (e) => e instanceof DomainServiceError && e.code === "limit");
    }));

    test("after a downgrade an active domain serves through the grace period, then stops", () => hosted(async () => {
      const { provider, hosts, deps } = setup();
      const dave = { ownerSub: "dave-sub", siteId: await siteForOwner("dave-sub") };
      await setPlan(dave.siteId, "pro");
      const view = await addSiteDomain(dave, "www.dave-site.com", deps);
      provider.set(refOf(provider, "www.dave-site.com"), ACTIVE);
      await checkSiteDomain(dave, view.domain.id, deps);
      assert.equal(hosts.has("www.dave-site.com"), true);

      await setPlan(dave.siteId, "free");
      await reverifyDomains(deps);
      assert.equal(hosts.has("www.dave-site.com"), true, "keeps serving during the grace period");
      const [row] = await query<{ grace_until: Date | null }>("SELECT grace_until FROM site_domains WHERE id = $1", [view.domain.id]);
      assert.ok(row?.grace_until && row.grace_until.getTime() > Date.now() + 13 * 86_400_000);

      await query("UPDATE site_domains SET grace_until = now() - interval '1 minute' WHERE id = $1", [view.domain.id]);
      await reverifyDomains(deps);
      assert.equal(hosts.has("www.dave-site.com"), false, "stops once the grace period has passed");
      assert.equal((await findHeldDomain("www.dave-site.com"))?.status, "error");

      await setPlan(dave.siteId, "pro");
      await checkSiteDomain(dave, view.domain.id, deps);
      assert.equal(hosts.has("www.dave-site.com"), true, "upgrading again serves it again");
    }));
  }
});
