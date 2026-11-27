// Sign-in with server-side sessions (#16): Postgres plus TOKEN_ENCRYPTION_KEY.
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

describe("server-side sessions", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let app;
  before(async () => {
    await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    app = await startApp({
      google: true,
      env: { DATABASE_URL: dbUrl, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") },
    });
  });
  after(async () => {
    await app?.stop();
  });

  async function signIn() {
    const start = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
    const location = new URL(start.headers.get("location"));
    assert.equal(location.searchParams.get("access_type"), "offline");
    const jar = cookiesFrom(start);
    const res = await fetch(
      `${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(location.searchParams.get("state"))}`,
      { redirect: "manual", headers: { cookie: cookieHeader(jar), "user-agent": "session-test" } },
    );
    assert.equal(new URL(res.headers.get("location")).search, "", "sign-in succeeded");
    return { res, set: cookiesFrom(res) };
  }

  test("the browser gets only an opaque session id, never a Google token", async () => {
    const { res, set } = await signIn();
    assert.ok(set.pf_session, "session cookie set");
    assert.ok(set.pf_session.length >= 40);
    assert.equal(set.pf_access, "", "no token cookie");
    const raw = res.headers.getSetCookie().join("\n");
    assert.doesNotMatch(raw, /fake-token|fake-refresh-token/);
    assert.match(raw.split("\n").find((line) => line.startsWith("pf_session=")), /HttpOnly/i);
  });

  test("the session reaches Google through the server and no response leaks a token", async () => {
    const { set } = await signIn();
    const cookie = `pf_session=${set.pf_session}`;
    const library = await fetch(`${app.base}/api/pages`, { headers: { cookie } });
    assert.equal(library.status, 200);
    const text = await library.text();
    assert.equal(JSON.parse(text).sample, false);
    const sessions = await fetch(`${app.base}/api/auth/sessions`, { headers: { cookie } });
    const listed = await sessions.json();
    assert.ok(listed.sessions.some((s) => s.current && s.userAgent === "session-test"));
    for (const body of [text, JSON.stringify(listed)]) assert.doesNotMatch(body, /fake-token|fake-refresh-token/);
  });

  test("the database holds no plaintext token or session id", async () => {
    const { set } = await signIn();
    const dump = JSON.stringify([await sql("SELECT * FROM google_tokens"), await sql("SELECT * FROM sessions")]);
    for (const secret of ["fake-token", "fake-refresh-token", set.pf_session]) assert.ok(!dump.includes(secret), secret);
  });

  test("a stolen session id is useless after sign-out", async () => {
    const { set } = await signIn();
    const cookie = `pf_session=${set.pf_session}`;
    const out = await fetch(`${app.base}/api/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: app.base },
    });
    assert.equal(out.status, 303);
    assert.equal(cookiesFrom(out).pf_session, "");
    const replay = await fetch(`${app.base}/api/pages`, { headers: { cookie } });
    assert.equal((await replay.json()).sample, true, "the replayed cookie is signed out");
    assert.equal((await fetch(`${app.base}/api/auth/sessions`, { headers: { cookie } })).status, 401);
  });

  test("sign out everywhere ends every session and deletes the grant", async () => {
    const a = await signIn();
    const b = await signIn();
    const out = await fetch(`${app.base}/api/auth/disconnect`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: `pf_session=${a.set.pf_session}`, origin: app.base },
    });
    assert.equal(out.status, 303);
    for (const id of [a.set.pf_session, b.set.pf_session]) {
      const res = await fetch(`${app.base}/api/auth/sessions`, { headers: { cookie: `pf_session=${id}` } });
      assert.equal(res.status, 401);
    }
    assert.equal((await sql("SELECT 1 FROM google_tokens")).length, 0);
  });
});
