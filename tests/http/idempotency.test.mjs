// Idempotency keys on /api/v1 mutations (#38).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { cookieHeader, cookiesFrom, startApp } from "./server.mjs";

const dbUrl = process.env.TEST_DATABASE_URL?.trim() || null;
if (!dbUrl && process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI");

async function sql(text) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
}

describe("Idempotency-Key on /api/v1", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let app;
  let auth;
  before(async () => {
    await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    app = await startApp({ google: true, env: { DATABASE_URL: dbUrl, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") } });
    const start = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const callback = await fetch(`${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(state)}`, { redirect: "manual", headers: { cookie: cookieHeader(cookiesFrom(start)) } });
    const headers = { cookie: `pf_session=${cookiesFrom(callback).pf_session}`, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    const created = await (await fetch(`${app.base}/api/keys`, { method: "POST", headers, body: JSON.stringify({ name: "bulk", scopes: ["pages:read", "pages:commit", "pages:publish"] }) })).json();
    auth = { authorization: `Bearer ${created.key}`, "content-type": "application/json" };
  });
  after(async () => {
    await app?.stop();
  });

  const create = (headers, body = { title: "Hello" }) =>
    fetch(`${app.base}/api/v1/pages`, { method: "POST", headers: { ...auth, ...headers }, body: JSON.stringify(body) });

  test("a mutation without a key is refused, a malformed key too", async () => {
    const missing = await create({});
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, "invalid");
    assert.equal((await create({ "idempotency-key": "has spaces" })).status, 400);
  });

  test("a retry with the same key and body gets the first response, marked as a replay", async () => {
    const first = await create({ "idempotency-key": "retry-1" });
    const firstBody = await first.text();
    const second = await create({ "idempotency-key": "retry-1" });
    assert.equal(second.status, first.status);
    assert.equal(await second.text(), firstBody);
    assert.equal(second.headers.get("idempotent-replayed"), "true");
    assert.equal(first.headers.get("idempotent-replayed"), null);
  });

  test("the same key with a different body is 422 idempotency_mismatch", async () => {
    await create({ "idempotency-key": "mismatch-1" });
    const res = await create({ "idempotency-key": "mismatch-1" }, { title: "Different" });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.code, "idempotency_mismatch");
  });

  test("reads do not need a key", async () => {
    assert.equal((await fetch(`${app.base}/api/v1/pages`, { headers: auth })).status, 200);
  });
});
