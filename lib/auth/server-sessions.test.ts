import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import {
  IDLE_TIMEOUT_MS,
  accessTokenFor,
  createSession,
  disconnectGoogle,
  hashSessionId,
  listSessions,
  readSession,
  saveGrant,
  signOut,
} from "./server-sessions";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

type GoogleCalls = { refresh: number; revoke: string[] };
function fakeGoogle(behaviour: { refreshStatus?: number; delayMs?: number } = {}): GoogleCalls {
  const calls: GoogleCalls = { refresh: 0, revoke: [] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = new URL(String(input));
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (target.pathname === "/token" && form.get("grant_type") === "refresh_token") {
      calls.refresh += 1;
      if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs));
      if (behaviour.refreshStatus) return new Response("{}", { status: behaviour.refreshStatus });
      return new Response(JSON.stringify({ access_token: `ya29.refreshed-${calls.refresh}`, expires_in: 3600 }));
    }
    if (target.pathname === "/revoke") {
      calls.revoke.push(form.get("token") ?? "");
      return new Response("");
    }
    throw new Error(`unexpected ${target}`);
  }) as typeof fetch;
  return calls;
}

const grant = (accessToken: string, expiresInSeconds = 3600, refreshToken: string | null = "1//refresh-a") => ({
  accessToken,
  refreshToken,
  expiresInSeconds,
  scope: "openid drive.file",
});

describe("server sessions", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM sessions");
    await query("DELETE FROM google_tokens");
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => {
    await closeDatabase();
  });

  test("stores tokens sealed: nothing in the database contains them", async () => {
    await saveGrant("u1", "u1@example.com", grant("ya29.access-plain"));
    const id = await createSession("u1", "Test browser");
    const dump = JSON.stringify([
      await query("SELECT * FROM google_tokens"),
      await query("SELECT * FROM sessions"),
    ]);
    for (const secret of ["ya29.access-plain", "1//refresh-a", id]) assert.ok(!dump.includes(secret), secret);
    assert.ok(dump.includes(hashSessionId(id)));
  });

  test("returns the cached access token while it is fresh", async () => {
    const calls = fakeGoogle();
    await saveGrant("u1", null, grant("ya29.cached"));
    assert.equal(await accessTokenFor("u1"), "ya29.cached");
    assert.equal(calls.refresh, 0);
  });

  test("refreshes an expiring token once, however many callers ask at the same time", async () => {
    const calls = fakeGoogle({ delayMs: 50 });
    await saveGrant("u1", null, grant("ya29.old", 30));
    const tokens = await Promise.all(Array.from({ length: 5 }, () => accessTokenFor("u1")));
    assert.deepEqual(new Set(tokens), new Set(["ya29.refreshed-1"]));
    assert.equal(calls.refresh, 1);
    assert.equal(await accessTokenFor("u1"), "ya29.refreshed-1", "the refreshed token is cached");
  });

  test("forgets a grant Google has revoked", async () => {
    fakeGoogle({ refreshStatus: 400 });
    await saveGrant("u1", null, grant("ya29.old", 30));
    assert.equal(await accessTokenFor("u1"), null);
    assert.equal((await query("SELECT 1 FROM google_tokens")).length, 0);
  });

  test("a sign-in without a refresh token keeps the stored one", async () => {
    const calls = fakeGoogle();
    await saveGrant("u1", null, grant("ya29.first"));
    await saveGrant("u1", null, grant("ya29.second", 30, null));
    await accessTokenFor("u1");
    await disconnectGoogle("u1");
    assert.deepEqual(calls.revoke, ["1//refresh-a"]);
  });

  test("a sign-in with no refresh token and nothing stored fails", async () => {
    await assert.rejects(saveGrant("new-user", null, grant("ya29.x", 3600, null)), /refresh token/);
  });

  test("sessions expire after the idle timeout", async () => {
    await saveGrant("u1", null, grant("ya29.a"));
    const id = await createSession("u1", null);
    assert.equal((await readSession(id))?.sub, "u1");
    await query("UPDATE sessions SET last_seen_at = now() - make_interval(secs => $1)", [IDLE_TIMEOUT_MS / 1000 + 60]);
    assert.equal(await readSession(id), null);
    assert.equal((await query("SELECT 1 FROM sessions")).length, 0, "an expired session is deleted");
  });

  test("sessions expire after the absolute timeout even when active", async () => {
    await saveGrant("u1", null, grant("ya29.a"));
    const id = await createSession("u1", null);
    await query("UPDATE sessions SET created_at = now() - interval '31 days'");
    assert.equal(await readSession(id), null);
  });

  test("signing out of one of two sessions keeps the grant; the last one revokes it", async () => {
    const calls = fakeGoogle();
    await saveGrant("u1", null, grant("ya29.a"));
    const first = await createSession("u1", "Laptop");
    const second = await createSession("u1", "Phone");
    const listed = await listSessions("u1", first);
    assert.equal(listed.length, 2);
    assert.equal(listed.filter((s) => s.current).length, 1);

    await signOut(first);
    assert.equal(calls.revoke.length, 0);
    assert.ok(await accessTokenFor("u1"));

    await signOut(second);
    assert.deepEqual(calls.revoke, ["1//refresh-a"]);
    assert.equal(await accessTokenFor("u1"), null);
  });

  test("disconnect revokes and ends every session", async () => {
    const calls = fakeGoogle();
    await saveGrant("u1", null, grant("ya29.a"));
    const a = await createSession("u1", null);
    const b = await createSession("u1", null);
    await disconnectGoogle("u1");
    assert.equal(calls.revoke.length, 1);
    assert.equal(await readSession(a), null);
    assert.equal(await readSession(b), null);
  });
});
