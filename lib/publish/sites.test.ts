import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { handleSiteRequest, type R2BucketLike } from "./site-worker";
import { publishDomain, publishToOwnSite, siteHostname, sitePublishingEnabled } from "./sites";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

/** A fake R2 REST API that keeps objects in memory and can be served by the real Worker. */
function fakeR2() {
  const objects = new Map<string, { body: string; type: string | null; csp: string | null }>();
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const match = target.pathname.match(/\/r2\/buckets\/[^/]+\/objects\/(.+)$/);
    if (!match) throw new Error(`unexpected ${target}`);
    const key = match[1]!.split("/").map(decodeURIComponent).join("/");
    const headers = new Headers(init?.headers);
    methods.push(`${init?.method} ${key}`);
    if (init?.method === "PUT") objects.set(key, { body: String(init.body), type: headers.get("content-type"), csp: headers.get("cf-r2-meta-csp") });
    if (init?.method === "DELETE") objects.delete(key);
    return new Response("{}");
  }) as typeof fetch;
  const bucket: R2BucketLike = {
    async get(key) {
      const file = objects.get(key);
      if (!file) return null;
      return {
        body: new Response(file.body).body,
        httpEtag: '"x"',
        httpMetadata: { contentType: file.type ?? undefined },
        customMetadata: file.csp ? { csp: file.csp } : undefined,
        text: async () => file.body,
      };
    },
  };
  return { objects, methods, bucket };
}

const page = (text: string) => ({ html: `<p>${text}</p>`, csp: "default-src 'none'", assets: [] });

describe("publish domain", () => {
  test("accepts a bare or wildcard domain and rejects junk", () => {
    process.env.PUBLISH_DOMAIN = "*.Sites.Example.";
    assert.equal(publishDomain(), "sites.example");
    process.env.PUBLISH_DOMAIN = "not a domain";
    assert.equal(publishDomain(), null);
    delete process.env.PUBLISH_DOMAIN;
    assert.equal(sitePublishingEnabled(), false);
  });
});

describe("publishing to your own site", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
    process.env.PUBLISH_DOMAIN = "sites.example";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.R2_BUCKET = "pagefirst-sites";
    process.env.R2_API_TOKEN = "r2-token";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => {
    for (const name of ["PUBLISH_DOMAIN", "CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_API_TOKEN"]) delete process.env[name];
    await closeDatabase();
  });

  test("two accounts publish the same path to their own sites without touching each other", async () => {
    const r2 = fakeR2();
    assert.equal(sitePublishingEnabled(), true);
    const alice = await publishToOwnSite("alice-sub", "about", page("alice"));
    const bob = await publishToOwnSite("bob-sub", "about", page("bob"));
    assert.notEqual(alice.siteId, bob.siteId);
    assert.notEqual(new URL(alice.url).hostname, new URL(bob.url).hostname);
    assert.match(alice.url, /^https:\/\/p[a-z0-9]{9}\.sites\.example\/about$/);

    // Bob publishing again rewrites only his own files.
    await publishToOwnSite("bob-sub", "about", page("bob v2"));
    assert.ok(r2.methods.every((m) => !m.startsWith("DELETE")));
    const env = { SITES: r2.bucket };
    assert.equal(await (await handleSiteRequest(new Request(alice.url), env)).text(), "<p>alice</p>");
    assert.equal(await (await handleSiteRequest(new Request(bob.url), env)).text(), "<p>bob v2</p>");
    const writesForAlice = r2.methods.filter((m) => m.includes(alice.siteId));
    assert.equal(writesForAlice.length, 1, "only Alice's own publish wrote to her folder");
  });

  test("publishing one page leaves the site's other pages in place", async () => {
    const r2 = fakeR2();
    const home = await publishToOwnSite("carol-sub", "index", { ...page("home"), assets: [{ path: "assets/pf/abc123.css", contentType: "text/css", body: ".a{}" }] });
    await publishToOwnSite("carol-sub", "blog/post", page("post"));
    const env = { SITES: r2.bucket };
    assert.equal(home.url.endsWith(".sites.example/"), true);
    assert.equal(await (await handleSiteRequest(new Request(home.url), env)).text(), "<p>home</p>");
    assert.equal(await (await handleSiteRequest(new Request(`${home.url}blog/post`), env)).text(), "<p>post</p>");
    assert.equal(await (await handleSiteRequest(new Request(`${home.url}assets/pf/abc123.css`), env)).text(), ".a{}");
    const served = await handleSiteRequest(new Request(home.url), env);
    assert.equal(served.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
  });

  test("a site keeps its address once assigned", async () => {
    fakeR2();
    const first = await publishToOwnSite("dave-sub", "about", page("x"));
    const [site] = await query<{ id: string }>("SELECT id FROM sites WHERE owner_sub = 'dave-sub'");
    assert.equal(await siteHostname(site!.id), new URL(first.url).hostname);
    const again = await publishToOwnSite("dave-sub", "about", page("y"));
    assert.equal(again.url, first.url);
  });
});
