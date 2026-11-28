import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { closeOrganization } from "./offboard";
import { addMember, createOrganization, getOrganization } from "./orgs";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

describe("closing an organization", { skip: url ? false : "TEST_DATABASE_URL not set" }, () => {
  let calls: { method: string; url: string }[] = [];

  before(async () => {
    process.env.DATABASE_URL = url ?? undefined;
  });
  after(async () => {
    delete process.env.DATABASE_URL;
    await closeDatabase();
  });
  beforeEach(async () => {
    await resetTestDatabase(url!);
    calls = [];
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.R2_BUCKET = "bucket";
    process.env.R2_API_TOKEN = "token";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url: String(input) });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await query("INSERT INTO users (sub, email) VALUES ('sub-a', 'a@example.com'), ('sub-b', 'b@example.com') ON CONFLICT DO NOTHING");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const name of ["CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_API_TOKEN"]) delete process.env[name];
  });

  test("removes every recorded file of every site, then the organization", async () => {
    const org = await createOrganization("sub-a", "Acme");
    await addMember(org.id, "sub-b", "editor");
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ('site_one', 'sub-a', $1)", [org.id]);
    await query(
      `INSERT INTO site_files (site_id, key, sha256) VALUES
        ('site_one', 'sites/site_one/index.html', 'a'),
        ('site_one', 'host:p1.pages.example', 'b'),
        ('site_one', 'assets/app.css', 'c')`,
    );
    const result = await closeOrganization(org.id);
    assert.deepEqual(result, { sites: 1, files: 3 });
    const deleted = calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.split("/objects/")[1] ?? ""));
    assert.deepEqual(deleted.sort(), ["hosts/p1.pages.example", "sites/site_one/assets/app.css", "sites/site_one/index.html"]);
    assert.equal(await getOrganization(org.id), null);
    assert.equal((await query("SELECT 1 FROM sites WHERE id = 'site_one'")).length, 0);
  });

  test("a storage failure leaves the organization in place", async () => {
    const org = await createOrganization("sub-a", "Acme");
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ('site_two', 'sub-a', $1)", [org.id]);
    await query("INSERT INTO site_files (site_id, key, sha256) VALUES ('site_two', 'sites/site_two/index.html', 'a')");
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as typeof fetch;
    await assert.rejects(closeOrganization(org.id), /answered 500/);
    assert.ok(await getOrganization(org.id));
    assert.equal((await query("SELECT 1 FROM sites WHERE id = 'site_two'")).length, 1);
  });
});
