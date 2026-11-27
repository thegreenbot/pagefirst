// Audit log (#17): each mutating call writes one event, with no Doc text or tokens.
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

/** Audit inserts finish before the response is sent, so no waiting is needed. */
async function eventsAfter(id) {
  return sql("SELECT * FROM audit_events WHERE id > $1 ORDER BY id", [id]);
}

async function lastId() {
  const [row] = await sql("SELECT coalesce(max(id), 0)::bigint AS id FROM audit_events");
  return row.id;
}

describe("audit log over HTTP", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let app;
  let cookie;
  before(async () => {
    await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    app = await startApp({
      google: true,
      env: {
        DATABASE_URL: dbUrl,
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
        AUDIT_ADMIN_EMAILS: "author@example.com",
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

  const post = (path, body, ip = "203.0.113.50") =>
    fetch(`${app.base}${path}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    });

  test("sign-in wrote one event for the account", async () => {
    const rows = await sql("SELECT * FROM audit_events WHERE event = 'auth.sign_in'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_sub, "fake-sub");
    assert.equal(rows[0].outcome, "ok");
  });

  test("a commit writes exactly one event with revisions and op kinds, but no text", async () => {
    const since = await lastId();
    const res = await post("/api/pages/doc1/commit", {
      baseRevisionId: "rev-2",
      ops: [{ op: "setMetadata", key: "description", value: "DISTINCTIVE-DOC-TEXT-91" }],
    });
    const rows = await eventsAfter(since);
    assert.equal(rows.length, 1, JSON.stringify(rows));
    const [row] = rows;
    assert.equal(row.event, "page.commit");
    assert.equal(row.actor_sub, "fake-sub");
    assert.equal(row.file_id, "doc1");
    assert.equal(row.base_revision_id, "rev-2");
    assert.equal(row.status, res.status);
    assert.equal(row.op_count, 1);
    assert.deepEqual(row.op_kinds, ["setMetadata"]);
    assert.equal(row.request_id, res.headers.get("x-request-id"));
    const dump = JSON.stringify(await sql("SELECT * FROM audit_events"));
    for (const secret of ["DISTINCTIVE-DOC-TEXT-91", "fake-token", "fake-refresh-token", "203.0.113.50"]) {
      assert.ok(!dump.includes(secret), secret);
    }
  });

  test("a publish writes exactly one event", async () => {
    const since = await lastId();
    const res = await post("/api/pages/doc1/publish", {});
    assert.equal(res.status, 200);
    const rows = await eventsAfter(since);
    assert.deepEqual(rows.map((row) => [row.event, row.outcome]), [["page.publish", "ok"]]);
  });

  test("a rate-limited call is recorded as denied", async () => {
    for (let i = 0; i < 6; i += 1) await post("/api/pages/doc1/publish", {}, "203.0.113.51");
    const since = await lastId();
    const res = await post("/api/pages/doc1/publish", {}, "203.0.113.51");
    assert.equal(res.status, 429);
    const rows = await eventsAfter(since);
    assert.deepEqual(rows.map((row) => [row.event, row.outcome, row.status]), [["request.denied", "denied", 429]]);
  });

  test("the account can read its own activity, and an admin can export a range", async () => {
    const own = await fetch(`${app.base}/api/audit`, { headers: { cookie } });
    assert.equal(own.status, 200);
    const { events } = await own.json();
    assert.ok(events.some((event) => event.event === "page.commit"));
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const range = await fetch(`${app.base}/api/audit?from=${from}&to=${to}`, { headers: { cookie } });
    assert.equal(range.status, 200);
    assert.ok((await range.json()).events.length >= events.length);
    assert.equal((await fetch(`${app.base}/api/audit`)).status, 401);
  });

  test("the database refuses to change history", async () => {
    await assert.rejects(sql("UPDATE audit_events SET outcome = 'ok'"), /append-only/);
    await assert.rejects(sql("DELETE FROM audit_events"), /append-only/);
  });

  test("sign-out writes one event", async () => {
    const since = await lastId();
    const res = await fetch(`${app.base}/api/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "sec-fetch-site": "same-origin" },
    });
    assert.equal(res.status, 303);
    const rows = await eventsAfter(since);
    assert.deepEqual(rows.map((row) => [row.event, row.actor_sub]), [["auth.sign_out", "fake-sub"]]);
  });
});
