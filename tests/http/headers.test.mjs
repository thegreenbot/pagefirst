import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./server.mjs";

describe("security headers", () => {
  let app;
  before(async () => {
    app = await startApp({ google: false });
  });
  after(async () => {
    await app?.stop();
  });

  function nonceOf(res) {
    const policy = res.headers.get("content-security-policy") ?? "";
    return policy.match(/'nonce-([^']+)'/)?.[1];
  }

  for (const path of ["/", "/plan", "/edit/about"]) {
    test(`${path} sends a nonce CSP and every script carries the nonce`, async () => {
      const res = await fetch(`${app.base}${path}`);
      assert.equal(res.status, 200);
      const policy = res.headers.get("content-security-policy");
      assert.match(policy, /script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
      assert.match(policy, /frame-ancestors 'none'/);
      assert.doesNotMatch(policy, /unsafe-eval/);
      const nonce = nonceOf(res);
      const html = await res.text();
      const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
      assert.ok(scripts.length > 0, "page has scripts");
      for (const script of scripts) assert.ok(script.includes(`nonce="${nonce}"`), script);
    });
  }

  test("each request gets a different nonce", async () => {
    const a = nonceOf(await fetch(`${app.base}/`));
    const b = nonceOf(await fetch(`${app.base}/`));
    assert.ok(a && b && a !== b);
  });

  test("pages and API routes send the baseline headers", async () => {
    for (const path of ["/", "/api/pages"]) {
      const res = await fetch(`${app.base}${path}`);
      assert.match(res.headers.get("strict-transport-security") ?? "", /max-age=\d+/, path);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
      assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
      assert.equal(res.headers.get("x-frame-options"), "DENY", path);
      assert.match(res.headers.get("permissions-policy") ?? "", /camera=\(\)/, path);
      assert.equal(res.headers.get("x-powered-by"), null, path);
    }
  });

  test("a published preview allows no script and cannot be framed", async () => {
    const published = await fetch(`${app.base}/api/pages/about/publish`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.77" },
    });
    assert.equal(published.status, 200);
    const res = await fetch(`${app.base}/published/about`);
    const policy = res.headers.get("content-security-policy");
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(await res.text(), /<meta http-equiv="Content-Security-Policy"/);
  });

  test("media downloads instead of rendering when opened directly", async () => {
    const res = await fetch(`${app.base}/api/media/sample-studio`);
    assert.match(res.headers.get("content-disposition") ?? "", /^attachment/);
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
  });
});
