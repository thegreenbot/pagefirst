// Shared state (#18): two app instances on one database share rate limits,
// published previews and uploaded images.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startApp } from "./server.mjs";

const dbUrl = process.env.TEST_DATABASE_URL?.trim() || null;
if (!dbUrl && process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI");

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe("two instances share state through Postgres", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let a;
  let b;
  before(async () => {
    const client = new pg.Client({ connectionString: dbUrl });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await client.end();
    [a, b] = await Promise.all([startApp({ env: { DATABASE_URL: dbUrl } }), startApp({ env: { DATABASE_URL: dbUrl } })]);
  });
  after(async () => {
    await Promise.all([a?.stop(), b?.stop()]);
  });

  const headers = (ip) => ({ "sec-fetch-site": "same-origin", "x-forwarded-for": ip });
  const publish = (app, ip) => fetch(`${app.base}/api/pages/about/publish`, { method: "POST", headers: headers(ip) });

  test("a publish limit used up on one instance holds on the other, with RateLimit headers", async () => {
    const ip = "198.51.100.200";
    for (let i = 0; i < 6; i += 1) {
      const res = await publish(i % 2 ? a : b, ip);
      assert.equal(res.status, 200, `call ${i + 1}`);
      assert.equal(res.headers.get("ratelimit-limit"), "6");
    }
    const refused = await publish(a, ip);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal(refused.headers.get("ratelimit-remaining"), "0");
    assert.ok(refused.headers.get("ratelimit-reset"));
  });

  test("a preview published on one instance is served by the other", async () => {
    const res = await publish(a, "198.51.100.201");
    assert.equal(res.status, 200);
    const { previewPath } = await res.json();
    const served = await fetch(`${b.base}${previewPath}`);
    assert.equal(served.status, 200);
    assert.match(served.headers.get("content-type"), /text\/html/);
  });

  test("an image uploaded on one instance is served by the other", async () => {
    const form = new FormData();
    form.set("file", new Blob([PNG], { type: "image/png" }), "upload");
    const res = await fetch(`${a.base}/api/media`, { method: "POST", body: form, headers: headers("198.51.100.202") });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    const served = await fetch(`${b.base}/api/media/${id}`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
  });
});
