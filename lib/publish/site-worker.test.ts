import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cacheControl, candidateKeys, DEFAULT_SITE_CSP, handleSiteRequest, type R2BucketLike, type R2ObjectBody } from "./site-worker";

function bucket(files: Record<string, { body: string; type?: string; csp?: string }>): R2BucketLike & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async get(key: string) {
      reads.push(key);
      const file = files[key];
      if (!file) return null;
      const object: R2ObjectBody = {
        body: new Response(file.body).body,
        httpEtag: `"etag-${key}"`,
        httpMetadata: file.type ? { contentType: file.type } : undefined,
        customMetadata: file.csp ? { csp: file.csp } : undefined,
        text: async () => file.body,
      };
      return object;
    },
  };
}

const files = {
  "hosts/alice.sites.example": { body: "alice" },
  "hosts/bob.sites.example": { body: "bob" },
  "hosts/evil.sites.example": { body: "../alice" },
  "sites/alice/index.html": { body: "alice home", type: "text/html; charset=utf-8", csp: "default-src 'none'" },
  "sites/alice/about.html": { body: "alice about", type: "text/html; charset=utf-8" },
  "sites/alice/blog/index.html": { body: "alice blog", type: "text/html; charset=utf-8" },
  "sites/bob/about.html": { body: "bob about", type: "text/html; charset=utf-8" },
};

const get = (env: { SITES: R2BucketLike }, url: string, init?: RequestInit) => handleSiteRequest(new Request(url, init), env);

describe("site worker", () => {
  test("serves each site's own page for the same path", async () => {
    const env = { SITES: bucket(files) };
    assert.equal(await (await get(env, "https://alice.sites.example/about")).text(), "alice about");
    assert.equal(await (await get(env, "https://bob.sites.example/about")).text(), "bob about");
    assert.equal(await (await get(env, "https://alice.sites.example/")).text(), "alice home");
    assert.equal(await (await get(env, "https://alice.sites.example/blog")).text(), "alice blog");
  });

  test("sends the stored CSP, or the default, plus frame-ancestors and nosniff", async () => {
    const env = { SITES: bucket(files) };
    const home = await get(env, "https://alice.sites.example/");
    assert.equal(home.headers.get("content-security-policy"), "default-src 'none'; frame-ancestors 'none'");
    assert.equal(home.headers.get("x-content-type-options"), "nosniff");
    const about = await get(env, "https://alice.sites.example/about");
    assert.equal(about.headers.get("content-security-policy"), `${DEFAULT_SITE_CSP}; frame-ancestors 'none'`);
  });

  test("never reads outside the site's folder", async () => {
    const env = { SITES: bucket(files) };
    for (const path of ["/../bob/about", "/%2e%2e/bob/about", "/..%2fbob%2fabout", "/a%5c..%5cb", "/.env"]) {
      const res = await get(env, `https://alice.sites.example${path}`);
      assert.equal(res.status, 404, path);
    }
    assert.ok(env.SITES.reads.every((key) => key.startsWith("hosts/") || key.startsWith("sites/alice/")), env.SITES.reads.join());
    assert.equal((await get(env, "https://evil.sites.example/about")).status, 404, "a malformed host record is ignored");
  });

  test("404s an unknown host and refuses writes", async () => {
    const env = { SITES: bucket(files) };
    assert.equal((await get(env, "https://nobody.sites.example/")).status, 404);
    const post = await get(env, "https://alice.sites.example/about", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });

  test("answers HEAD without a body and If-None-Match with 304", async () => {
    const env = { SITES: bucket(files) };
    const head = await get(env, "https://alice.sites.example/about", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const cached = await get(env, "https://alice.sites.example/about", { headers: { "if-none-match": '"etag-sites/alice/about.html"' } });
    assert.equal(cached.status, 304);
  });

  test("content-addressed assets are immutable; pages revalidate quickly", () => {
    assert.equal(cacheControl("about.html"), "public, max-age=60");
    assert.equal(cacheControl("assets/img/0123456789abcdef-480.avif"), "public, max-age=31536000, immutable");
    assert.equal(cacheControl("assets/pf/0123456789abcdef.css"), "public, max-age=31536000, immutable");
    assert.equal(cacheControl("favicon.ico"), "public, max-age=3600");
  });

  test("maps paths to keys", () => {
    assert.deepEqual(candidateKeys("/"), ["index.html"]);
    assert.deepEqual(candidateKeys("/a/b"), ["a/b.html", "a/b/index.html"]);
    assert.deepEqual(candidateKeys("/img/logo.png"), ["img/logo.png"]);
    assert.equal(candidateKeys("/a/../b"), null);
    assert.equal(candidateKeys("/%E0%A4%A"), null);
  });
});
