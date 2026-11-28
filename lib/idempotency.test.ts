import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import {
  beginIdempotent,
  derivedKey,
  finishIdempotent,
  hashRequest,
  IDEMPOTENCY_TTL_MS,
  IN_PROGRESS_STALE_MS,
  releaseIdempotent,
  shouldStore,
  validIdempotencyKey,
} from "./idempotency";

const url = testDatabaseUrl();

describe("idempotency helpers", () => {
  test("keys are short and plain", () => {
    assert.ok(validIdempotencyKey("a1b2-c3_d4.e5:f6"));
    for (const bad of ["", "a b", "x".repeat(256), "ü", "a\nb"]) assert.equal(validIdempotencyKey(bad), false);
  });

  test("the request hash covers method, path and body", () => {
    const base = hashRequest("POST", "/api/v1/pages/a/commits", "{}");
    assert.equal(base, hashRequest("POST", "/api/v1/pages/a/commits", "{}"));
    assert.notEqual(base, hashRequest("POST", "/api/v1/pages/b/commits", "{}"));
    assert.notEqual(base, hashRequest("POST", "/api/v1/pages/a/commits", "{ }"));
  });

  test("per-item keys are stable, distinct per item, and bounded", () => {
    assert.equal(derivedKey("job1", "page-a"), derivedKey("job1", "page-a"));
    assert.notEqual(derivedKey("job1", "page-a"), derivedKey("job1", "page-b"));
    assert.ok(validIdempotencyKey(derivedKey("j".repeat(255), "x")));
  });

  test("only answers that say something about the work are stored", () => {
    for (const status of [200, 201, 400, 404, 409, 422]) assert.equal(shouldStore(status), true);
    for (const status of [408, 429, 500, 502, 503]) assert.equal(shouldStore(status), false);
  });
});

describe("idempotency store in memory", () => {
  test("a retry replays the first response; a different body is a mismatch; a duplicate in flight is in_progress", async () => {
    delete process.env.DATABASE_URL;
    const cred = "mem-" + Math.random();
    assert.deepEqual(await beginIdempotent(cred, "k", "h1"), { state: "new" });
    assert.deepEqual(await beginIdempotent(cred, "k", "h1"), { state: "in_progress" });
    await finishIdempotent(cred, "k", { status: 200, body: '{"ok":true}' });
    assert.deepEqual(await beginIdempotent(cred, "k", "h1"), { state: "replay", response: { status: 200, body: '{"ok":true}' } });
    assert.deepEqual(await beginIdempotent(cred, "k", "h2"), { state: "mismatch" });
    assert.deepEqual(await beginIdempotent("other-" + cred, "k", "h2"), { state: "new" }, "keys are per credential");
  });

  test("keys expire after 24 hours and abandoned requests free their key", async () => {
    delete process.env.DATABASE_URL;
    const cred = "mem-" + Math.random();
    const t0 = Date.now();
    await beginIdempotent(cred, "k", "h", t0);
    await finishIdempotent(cred, "k", { status: 200, body: "{}" });
    assert.equal((await beginIdempotent(cred, "k", "h", t0 + IDEMPOTENCY_TTL_MS - 1)).state, "replay");
    assert.equal((await beginIdempotent(cred, "k", "h", t0 + IDEMPOTENCY_TTL_MS + 1)).state, "new");
    await beginIdempotent(cred, "stuck", "h", t0);
    assert.equal((await beginIdempotent(cred, "stuck", "h", t0 + IN_PROGRESS_STALE_MS + 1)).state, "new");
  });

  test("a 5xx or 429 frees the key so a retry runs the work", async () => {
    delete process.env.DATABASE_URL;
    const cred = "mem-" + Math.random();
    await beginIdempotent(cred, "k", "h");
    await finishIdempotent(cred, "k", { status: 503, body: "{}" });
    assert.deepEqual(await beginIdempotent(cred, "k", "h"), { state: "new" });
    await releaseIdempotent(cred, "k");
    assert.deepEqual(await beginIdempotent(cred, "k", "h"), { state: "new" });
  });
});

describe("idempotency store in Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    process.env.DATABASE_URL = url!;
    await query("DELETE FROM idempotency_keys").catch(() => undefined);
  });
  after(async () => {
    await closeDatabase();
  });

  test("twenty concurrent requests with one key: exactly one runs, the rest are in_progress", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => beginIdempotent("c1", "k", "h")));
    assert.equal(results.filter((r) => r.state === "new").length, 1);
    assert.equal(results.filter((r) => r.state === "in_progress").length, 19);
  });

  test("a finished request is replayed once, across the stale-row sweep", async () => {
    assert.equal((await beginIdempotent("c1", "k", "h")).state, "new");
    await finishIdempotent("c1", "k", { status: 201, body: '{"id":1}' });
    assert.deepEqual(await beginIdempotent("c1", "k", "h"), { state: "replay", response: { status: 201, body: '{"id":1}' } });
    assert.equal((await beginIdempotent("c1", "k", "other")).state, "mismatch");
    assert.equal((await beginIdempotent("c2", "k", "h")).state, "new");
  });

  test("expired rows and stuck in_progress rows are reclaimed", async () => {
    await beginIdempotent("c1", "old", "h");
    await finishIdempotent("c1", "old", { status: 200, body: "{}" });
    await query("UPDATE idempotency_keys SET expires_at = now() - interval '1 second' WHERE key = 'old'");
    assert.equal((await beginIdempotent("c1", "old", "h")).state, "new");
    await beginIdempotent("c1", "stuck", "h");
    await query("UPDATE idempotency_keys SET created_at = now() - interval '3 minutes' WHERE key = 'stuck'");
    assert.equal((await beginIdempotent("c1", "stuck", "h")).state, "new");
  });

  test("a 503 releases the key", async () => {
    await beginIdempotent("c1", "k", "h");
    await finishIdempotent("c1", "k", { status: 503, body: "{}" });
    assert.equal((await beginIdempotent("c1", "k", "h")).state, "new");
  });
});
