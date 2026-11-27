import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./server.mjs";

let nextIp = 1;
/** Each test gets its own client address so per-caller rate limits stay independent. */
function client() {
  nextIp += 1;
  return `198.51.100.${nextIp}`;
}

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function upload(base, { bytes, type, headers }) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type }), "upload");
  return fetch(`${base}/api/media`, { method: "POST", body: form, headers });
}

describe("publish and media in sample mode", () => {
  let app;
  before(async () => {
    app = await startApp({ google: false });
  });
  after(async () => {
    await app?.stop();
  });

  const sameSite = (ip) => ({ "sec-fetch-site": "same-origin", "x-forwarded-for": ip });
  const crossSite = (ip) => ({ "sec-fetch-site": "cross-site", origin: "https://evil.example", "x-forwarded-for": ip });

  test("publishes a preview for a same-origin caller", async () => {
    const res = await fetch(`${app.base}/api/pages/about/publish`, {
      method: "POST",
      headers: { ...sameSite(client()), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.previewPath, "/published/about");
    assert.equal(body.url, undefined);
    const preview = await fetch(`${app.base}${body.previewPath}`);
    assert.equal(preview.status, 200);
  });

  test("refuses a cross-site publish while signed out", async () => {
    const res = await fetch(`${app.base}/api/pages/about/publish`, { method: "POST", headers: crossSite(client()) });
    assert.equal(res.status, 401);
  });

  test("never publishes publicly while signed out", async () => {
    const res = await fetch(`${app.base}/api/pages/about/publish`, {
      method: "POST",
      headers: { ...sameSite(client()), "content-type": "application/json" },
      body: JSON.stringify({ public: true }),
    });
    const body = await res.json();
    assert.equal(body.url, undefined);
    assert.match(body.warning, /Sign in/);
  });

  test("rate-limits publish to 6 a minute per caller", async () => {
    const ip = client();
    const statuses = [];
    for (let i = 0; i < 7; i += 1) {
      const res = await fetch(`${app.base}/api/pages/about/publish`, { method: "POST", headers: sameSite(ip) });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
  });

  test("publish 400s an unsafe id and 404s an unknown page", async () => {
    const headers = sameSite(client());
    assert.equal((await fetch(`${app.base}/api/pages/bad%20id/publish`, { method: "POST", headers })).status, 400);
    assert.equal((await fetch(`${app.base}/api/pages/nope/publish`, { method: "POST", headers })).status, 404);
  });

  test("accepts a PNG and serves it back with nosniff", async () => {
    const res = await upload(app.base, { bytes: PNG, type: "image/png", headers: sameSite(client()) });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const served = await fetch(`${app.base}/api/media/${id}`);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  });

  test("rejects types outside the image allow list with 415", async () => {
    const ip = client();
    for (const type of ["image/svg+xml", "text/html", "application/octet-stream", ""]) {
      const res = await upload(app.base, { bytes: PNG, type, headers: sameSite(ip) });
      assert.equal(res.status, 415, type || "(no type)");
    }
  });

  test("rejects markup disguised as an image with 415", async () => {
    const ip = client();
    for (const text of ["<svg onload=alert(1)>", "  <?xml version='1.0'?><svg/>", "<html><script>x</script>"]) {
      const res = await upload(app.base, { bytes: new TextEncoder().encode(text), type: "image/png", headers: sameSite(ip) });
      assert.equal(res.status, 415, text);
    }
  });

  test("rejects an image over 2 MB with 413", async () => {
    const big = new Uint8Array(2_000_001);
    big.set(PNG);
    const res = await upload(app.base, { bytes: big, type: "image/png", headers: sameSite(client()) });
    assert.equal(res.status, 413);
  });

  test("rejects a cross-site upload while signed out", async () => {
    const res = await upload(app.base, { bytes: PNG, type: "image/png", headers: crossSite(client()) });
    assert.equal(res.status, 401);
  });

  test("rate-limits uploads to 8 a minute per caller", async () => {
    const ip = client();
    const statuses = [];
    for (let i = 0; i < 9; i += 1) {
      statuses.push((await upload(app.base, { bytes: new Uint8Array([1]), type: "text/plain", headers: sameSite(ip) })).status);
    }
    assert.deepEqual(statuses, [415, 415, 415, 415, 415, 415, 415, 415, 429]);
  });

  test("media 400s an unsafe id and 404s an unknown one", async () => {
    assert.equal((await fetch(`${app.base}/api/media/bad%20id`)).status, 400);
    assert.equal((await fetch(`${app.base}/api/media/m_unknown`)).status, 404);
  });

  test("the sample SVG is served under a sandboxing CSP", async () => {
    const res = await fetch(`${app.base}/api/media/sample-studio`);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.match(res.headers.get("content-security-policy"), /sandbox/);
  });
});

describe("publish signed in to Google", () => {
  let app;
  before(async () => {
    app = await startApp({ google: true });
  });
  after(async () => {
    await app?.stop();
  });

  test("refuses publish without a session", async () => {
    const res = await fetch(`${app.base}/api/pages/doc1/publish`, {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.status, 401);
  });

  test("publishes a preview of a Doc", async () => {
    const res = await fetch(`${app.base}/api/pages/doc1/publish`, {
      method: "POST",
      headers: { cookie: "pf_access=fake-token" },
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sample, false);
  });

  test("a failed public upload is a warning, not a leak", async () => {
    const res = await fetch(`${app.base}/api/pages/doc1/publish`, {
      method: "POST",
      headers: { cookie: "pf_access=fake-token", "content-type": "application/json" },
      body: JSON.stringify({ public: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, undefined);
    assert.ok(body.warning);
    assert.doesNotMatch(JSON.stringify(body), /fake-token/);
  });
});
