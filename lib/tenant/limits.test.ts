import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { checkPublishLimits, limitFor, PublishLimitError, publishUsage } from "./limits";
import { createOrganization, setPlan } from "./orgs";

function setEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

async function withEnv<T>(vars: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) setEnv(k, v);
  try {
    return await run();
  } finally {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  }
}

test("default limits per plan, and enterprise is unlimited", () => {
  assert.equal(limitFor("free", "livePages"), 10);
  assert.equal(limitFor("free", "publishesPerDay"), 20);
  assert.equal(limitFor("pro", "livePages"), 250);
  assert.equal(limitFor("team", "publishesPerDay"), 2500);
  assert.equal(limitFor("enterprise", "livePages"), null);
});

test("an environment variable overrides a limit", async () => {
  await withEnv({ PAGEFIRST_LIMIT_FREE_LIVE_PAGES: "3" }, () => assert.equal(limitFor("free", "livePages"), 3));
  await withEnv({ PAGEFIRST_LIMIT_PRO_LIVE_PAGES: "unlimited" }, () => assert.equal(limitFor("pro", "livePages"), null));
  await withEnv({ PAGEFIRST_LIMIT_FREE_LIVE_PAGES: "lots" }, () => assert.equal(limitFor("free", "livePages"), 10));
});

const url = testDatabaseUrl();
describe("publish limit enforcement (#195)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgId = "";
  const site = "site_limits";
  before(async () => {
    await resetTestDatabase(url!);
    await upsertUser("owner", "owner@example.com");
    orgId = (await createOrganization("owner", "Acme")).id;
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ($1, 'owner', $2)", [site, orgId]);
  });
  after(closeDatabase);

  test("self-hosted is never limited", async () => {
    await withEnv({ PAGEFIRST_EDITION: undefined, PAGEFIRST_LIMIT_FREE_LIVE_PAGES: "0" }, () => checkPublishLimits(site, "doc1"));
  });

  test("a free org stops at its live-page limit but may republish a live page", async () => {
    await withEnv({ PAGEFIRST_EDITION: "hosted", PAGEFIRST_LIMIT_FREE_LIVE_PAGES: "2" }, async () => {
      for (const f of ["a", "b"]) await query("INSERT INTO site_pages (site_id, file_id, path) VALUES ($1, $2, $2)", [site, f]);
      await checkPublishLimits(site, "a");
      await assert.rejects(() => checkPublishLimits(site, "c"), (e) => e instanceof PublishLimitError && e.limit === "livePages" && e.status === 402);
      await setPlan(orgId, "pro");
      await checkPublishLimits(site, "c");
      await setPlan(orgId, "free");
    });
  });

  test("publishes in the last 24 hours count, older ones do not", async () => {
    await withEnv({ PAGEFIRST_EDITION: "hosted", PAGEFIRST_LIMIT_FREE_PUBLISHES_PER_DAY: "2", PAGEFIRST_LIMIT_FREE_LIVE_PAGES: "unlimited" }, async () => {
      const add = (age: string) => query(
        `INSERT INTO audit_events (at, event, outcome, error_code, site_id) VALUES (now() - $1::interval, 'page.publish', 'ok', 'public', $2)`,
        [age, site],
      );
      await add("2 days");
      await add("1 hour");
      assert.equal((await publishUsage(site)).publishesToday, 1);
      await checkPublishLimits(site, "a");
      await add("2 hours");
      await assert.rejects(() => checkPublishLimits(site, "a"), (e) => e instanceof PublishLimitError && e.limit === "publishesPerDay");
    });
  });
});
