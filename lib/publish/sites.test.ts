import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { handleSiteRequest, SPECULATION_RULES_PATH, type R2BucketLike } from "./site-worker";
import { publishDomain, publishToOwnSite, siteHostname, sitePublishingEnabled } from "./sites";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

/** A fake R2 REST API that keeps objects in memory and can be served by the real Worker. */
function fakeR2() {
  const objects = new Map<string, { body: string; type: string | null; csp: string | null; link: string | null }>();
  const methods: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const match = target.pathname.match(/\/r2\/buckets\/[^/]+\/objects\/(.+)$/);
    if (!match) throw new Error(`unexpected ${target}`);
    const key = match[1]!.split("/").map(decodeURIComponent).join("/");
    const headers = new Headers(init?.headers);
    methods.push(`${init?.method} ${key}`);
    if (init?.method === "PUT") objects.set(key, {
        body: String(init.body),
        type: headers.get("content-type"),
        csp: headers.get("cf-r2-meta-csp"),
        link: headers.get("cf-r2-meta-link"),
      });
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
        customMetadata: file.csp || file.link ? { ...(file.csp ? { csp: file.csp } : {}), ...(file.link ? { link: file.link } : {}) } : undefined,
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

  test("republishing an unchanged page uploads nothing; a changed page uploads only itself", async () => {
    const r2 = fakeR2();
    const css = { path: "assets/pf/0123456789abcdef.css", contentType: "text/css", body: ".a{}" };
    const first = await publishToOwnSite("erin-sub", "about", { ...page("v1"), assets: [css] });
    assert.equal(first.uploaded, 3, "host record, stylesheet and page");
    const again = await publishToOwnSite("erin-sub", "about", { ...page("v1"), assets: [css] });
    assert.equal(again.uploaded, 0);
    const writes = r2.methods.length;
    const changed = await publishToOwnSite("erin-sub", "about", { ...page("v2"), assets: [css] });
    assert.equal(changed.uploaded, 1);
    assert.deepEqual(r2.methods.slice(writes), [`PUT sites/${first.siteId}/about.html`]);
  });

  test("pages carry their preload Link header and Speculation Rules; assets are immutable", async () => {
    const r2 = fakeR2();
    const preload = '</assets/img/0123456789abcdef-960.avif>; rel=preload; as=image; type="image/avif"; fetchpriority=high';
    const published = await publishToOwnSite("fran-sub", "about", { ...page("x"), preloads: [preload], assets: [{ path: "assets/img/0123456789abcdef-960.avif", contentType: "image/avif", body: "img" }] });
    const env = { SITES: r2.bucket };
    const served = await handleSiteRequest(new Request(published.url), env);
    assert.equal(served.headers.get("link"), preload);
    assert.equal(served.headers.get("speculation-rules"), `"${SPECULATION_RULES_PATH}"`);
    const rules = await handleSiteRequest(new Request(new URL(SPECULATION_RULES_PATH, published.url)), env);
    assert.equal(rules.headers.get("content-type"), "application/speculationrules+json");
    assert.deepEqual(JSON.parse(await rules.text()).prefetch[0].where, { href_matches: "/*" });
    const image = await handleSiteRequest(new Request(new URL("/assets/img/0123456789abcdef-960.avif", published.url)), env);
    assert.equal(image.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.equal(image.headers.get("link"), null);
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
