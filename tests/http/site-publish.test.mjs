// Public publishing to each account's own R2 site (#94).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { cookieHeader, cookiesFrom, startApp } from "./server.mjs";

const dbUrl = process.env.TEST_DATABASE_URL?.trim() || null;
if (!dbUrl && process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI");

async function sql(text, values = []) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    return (await client.query(text, values)).rows;
  } finally {
    await client.end();
  }
}

describe("publishing to your own site", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let app;
  let cookie;
  before(async () => {
    await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    app = await startApp({
      google: true,
      env: {
        DATABASE_URL: dbUrl,
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        // Nobody is allow-listed: per-site publishing doesn't need it.
        PUBLISH_ALLOWLIST: "",
        PUBLISH_DOMAIN: "sites.example",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        R2_BUCKET: "pagefirst-sites",
        R2_API_TOKEN: "fake-r2-token",
      },
    });
    const start = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const res = await fetch(`${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(cookiesFrom(start)) },
    });
    cookie = `pf_session=${cookiesFrom(res).pf_session}`;
  });
  after(async () => {
    await app?.stop();
  });

  test("a public publish goes to the account's own site and is audited with site and path", async () => {
    const res = await fetch(`${app.base}/api/pages/doc1/publish`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ public: true }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.warning, undefined, body.warning);
    assert.match(body.url, /^https:\/\/p[a-z0-9]{9}\.sites\.example\//);
    const [site] = await sql("SELECT id, subdomain FROM sites WHERE owner_sub = 'fake-sub'");
    assert.equal(new URL(body.url).hostname, `${site.subdomain}.sites.example`);
    const [event] = await sql("SELECT * FROM audit_events WHERE event = 'page.publish' ORDER BY id DESC LIMIT 1");
    assert.equal(event.outcome, "ok");
    assert.equal(event.site_id, site.id);
    assert.ok(event.page_path);
    assert.doesNotMatch(JSON.stringify(body), /fake-r2-token|fake-token/);
  });

  test("signed out, nothing is published publicly", async () => {
    const res = await fetch(`${app.base}/api/pages/doc1/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ public: true }),
    });
    assert.equal(res.status, 401);
  });
});
