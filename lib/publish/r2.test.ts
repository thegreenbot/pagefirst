import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { deleteSitePage, hostObjectKey, putHost, putSitePage, r2Configured, siteObjectKey } from "./r2";

const realFetch = globalThis.fetch;
type Call = { method: string; url: string; headers: Headers; body: string };

function fakeR2(status = 200): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    return new Response(status === 200 ? "{}" : "secret echo r2-token", { status });
  }) as typeof fetch;
  return calls;
}

function configure(): void {
  process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  process.env.R2_BUCKET = "pagefirst-sites";
  process.env.R2_API_TOKEN = "r2-token";
}

describe("R2 publishing", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.R2_BUCKET;
    delete process.env.R2_API_TOKEN;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });

  test("keys stay inside the site's folder", () => {
    assert.equal(siteObjectKey("s1", "index"), "sites/s1/index.html");
    assert.equal(siteObjectKey("s1", ""), "sites/s1/index.html");
    assert.equal(siteObjectKey("s1", "blog/post"), "sites/s1/blog/post.html");
    assert.throws(() => siteObjectKey("../s2", "x"), /site id/);
    assert.throws(() => siteObjectKey("s1", "../s2/x"), /page path/);
    assert.throws(() => siteObjectKey("s1", "a/%2e%2e/b"), /page path/);
    assert.equal(hostObjectKey("Alice.Sites.Example"), "hosts/alice.sites.example");
    assert.throws(() => hostObjectKey("../x"), /hostname/);
  });

  test("is off without all three variables", () => {
    assert.equal(r2Configured(), false);
    configure();
    assert.equal(r2Configured(), true);
  });

  test("writes one page with its CSP and the bucket token", async () => {
    configure();
    const calls = fakeR2();
    const key = await putSitePage("s1", "about", "<p>hi</p>", "default-src 'none'");
    assert.equal(key, "sites/s1/about.html");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "PUT");
    assert.equal(calls[0]?.url, "https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/pagefirst-sites/objects/sites/s1/about.html");
    assert.equal(calls[0]?.headers.get("authorization"), "Bearer r2-token");
    assert.equal(calls[0]?.headers.get("cf-r2-meta-csp"), "default-src 'none'");
    assert.equal(calls[0]?.body, "<p>hi</p>");
  });

  test("points a host at a site, and deletes a page (a missing page is fine)", async () => {
    configure();
    const calls = fakeR2();
    await putHost("alice.sites.example", "alice");
    assert.match(calls[0]?.url ?? "", /objects\/hosts\/alice\.sites\.example$/);
    assert.equal(calls[0]?.body, "alice");
    globalThis.fetch = realFetch;
    const missing = fakeR2(404);
    await deleteSitePage("alice", "old");
    assert.equal(missing[0]?.method, "DELETE");
  });

  test("a failure reports the status only, never the response or token", async () => {
    configure();
    fakeR2(403);
    await assert.rejects(putSitePage("s1", "about", "x", "y"), (error: Error) => {
      assert.equal(error.message, "Publishing storage answered 403");
      return true;
    });
  });
});
