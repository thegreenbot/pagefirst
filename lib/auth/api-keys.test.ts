import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { SCOPES } from "@/lib/service/context";
import {
  KEY_PREFIX,
  KeyInputError,
  MAX_ACTIVE_KEYS,
  createApiKey,
  hashApiKey,
  listApiKeys,
  looksLikeApiKey,
  parseNewKey,
  revokeApiKey,
  verifyApiKey,
} from "./api-keys";

describe("parseNewKey", () => {
  const ok = { name: "ci", scopes: ["pages:read"] };

  test("accepts a minimal request and defaults the expiry", () => {
    assert.deepEqual(parseNewKey(ok), { name: "ci", scopes: ["pages:read"], siteFolders: null, expiresInDays: 90 });
  });

  test("rejects unknown scopes, empty scope lists and bad names", () => {
    assert.throws(() => parseNewKey({ ...ok, scopes: ["pages:admin"] }), KeyInputError);
    assert.throws(() => parseNewKey({ ...ok, scopes: [] }), KeyInputError);
    assert.throws(() => parseNewKey({ ...ok, name: "  " }), KeyInputError);
    assert.throws(() => parseNewKey("nope"), KeyInputError);
  });

  test("validates folders and expiry", () => {
    assert.throws(() => parseNewKey({ ...ok, siteFolders: ["x"] }), KeyInputError);
    assert.throws(() => parseNewKey({ ...ok, siteFolders: [] }), KeyInputError);
    assert.throws(() => parseNewKey({ ...ok, expiresInDays: 0 }), KeyInputError);
    assert.throws(() => parseNewKey({ ...ok, expiresInDays: 366 }), KeyInputError);
    assert.deepEqual(parseNewKey({ ...ok, siteFolders: ["1AbCdEfGhIjKl", "1AbCdEfGhIjKl"], expiresInDays: 7 }).siteFolders, ["1AbCdEfGhIjKl"]);
  });

  test("never grants a scope that was not asked for", () => {
    assert.deepEqual(parseNewKey({ ...ok, scopes: ["pages:read", "pages:commit"] }).scopes, ["pages:read", "pages:commit"]);
    assert.ok(SCOPES.includes("pages:publish"));
  });

  test("recognises only well-formed keys", () => {
    assert.equal(looksLikeApiKey(`${KEY_PREFIX}${randomBytes(32).toString("base64url")}`), true);
    assert.equal(looksLikeApiKey("pf_live_short"), false);
    assert.equal(looksLikeApiKey("Bearer abc"), false);
  });
});

const url = testDatabaseUrl();

describe("api keys", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
    await upsertUser("sub-a", "a@example.com");
    await upsertUser("sub-b", "b@example.com");
  });
  beforeEach(async () => {
    await query("DELETE FROM api_keys");
  });
  after(async () => {
    await closeDatabase();
  });

  test("a created key verifies as its owner with exactly its scopes", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"], expiresInDays: 30 });
    assert.ok(key.startsWith(KEY_PREFIX));
    const verified = await verifyApiKey(key);
    assert.equal(verified?.sub, "sub-a");
    assert.equal(verified?.id, record.id);
    assert.deepEqual(verified?.scopes, ["pages:read"]);
  });

  test("only the hash is stored, never the key", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    const rows = await query<Record<string, unknown>>("SELECT * FROM api_keys");
    assert.equal(rows[0]?.key_hash, hashApiKey(key));
    assert.ok(!JSON.stringify(rows).includes(key));
    const listed = await listApiKeys("sub-a");
    assert.ok(!JSON.stringify(listed).includes(key));
  });

  test("revoking takes effect on the very next verification", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    assert.ok(await verifyApiKey(key));
    assert.equal(await revokeApiKey("sub-a", record.id), true);
    assert.equal(await verifyApiKey(key), null);
    assert.equal(await revokeApiKey("sub-a", record.id), false);
  });

  test("another user cannot revoke or see a key", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    assert.equal(await revokeApiKey("sub-b", record.id), false);
    assert.ok(await verifyApiKey(key));
    assert.deepEqual(await listApiKeys("sub-b"), []);
  });

  test("an expired key stops working", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    await query("UPDATE api_keys SET expires_at = now() - interval '1 second' WHERE id = $1", [record.id]);
    assert.equal(await verifyApiKey(key), null);
  });

  test("unknown and malformed keys verify as null", async () => {
    assert.equal(await verifyApiKey(`${KEY_PREFIX}${randomBytes(32).toString("base64url")}`), null);
    assert.equal(await verifyApiKey("nope"), null);
  });

  test("last_used_at is recorded", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    await verifyApiKey(key);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const [row] = await query<{ last_used_at: Date | null }>("SELECT last_used_at FROM api_keys WHERE id = $1", [record.id]);
    assert.ok(row?.last_used_at);
  });

  test("a user is capped at the active-key limit", async () => {
    for (let i = 0; i < MAX_ACTIVE_KEYS; i += 1) await createApiKey("sub-a", { name: `k${i}`, scopes: ["pages:read"] });
    await assert.rejects(createApiKey("sub-a", { name: "one too many", scopes: ["pages:read"] }), KeyInputError);
    await createApiKey("sub-b", { name: "other user", scopes: ["pages:read"] });
  });

  test("site folders round-trip", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"], siteFolders: ["1AbCdEfGhIjKl"] });
    assert.deepEqual((await verifyApiKey(key))?.siteFolders, ["1AbCdEfGhIjKl"]);
  });
});
