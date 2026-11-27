import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { authenticateBearer, bearerToken } from "./api-auth";
import { createApiKey, revokeApiKey } from "@/lib/auth/api-keys";
import { saveGrant } from "@/lib/auth/server-sessions";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { ServiceError, commit, createPage, listPages, publish } from "@/lib/service";

const req = (authorization?: string) => new Request("https://app.example/api/v1/me", { headers: authorization ? { authorization } : {} });

describe("bearerToken", () => {
  test("reads only the Authorization header", () => {
    assert.equal(bearerToken(req("Bearer abc")), "abc");
    assert.equal(bearerToken(req("bearer abc")), "abc");
    assert.equal(bearerToken(req("Basic abc")), null);
    assert.equal(bearerToken(new Request("https://app.example/", { headers: { cookie: "pf_session=abc" } })), null);
  });
});

const url = testDatabaseUrl();

describe("authenticateBearer", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM api_keys");
    await query("DELETE FROM google_tokens");
    await saveGrant("sub-a", "a@example.com", { accessToken: "ya29.owner", refreshToken: "1//r", expiresInSeconds: 3600, scope: "openid drive.file" });
  });
  after(async () => {
    await closeDatabase();
  });

  test("a valid key yields a context that runs as its owner with the key's scopes", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    const auth = await authenticateBearer(req(`Bearer ${key}`));
    assert.ok(auth.ok);
    if (!auth.ok) return;
    assert.equal(auth.ctx.actor.sub, "sub-a");
    assert.equal(auth.ctx.actor.client, "api");
    assert.equal(auth.ctx.googleToken, "ya29.owner");
    assert.deepEqual([...auth.ctx.scopes!], ["pages:read"]);
  });

  test("a read-only key cannot commit, create or publish through the service", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    const auth = await authenticateBearer(req(`Bearer ${key}`));
    assert.ok(auth.ok);
    if (!auth.ok) return;
    const forbidden = (err: unknown) => err instanceof ServiceError && err.code === "forbidden";
    await assert.rejects(commit(auth.ctx, "doc1", "r1", []), forbidden);
    await assert.rejects(createPage(auth.ctx, "x"), forbidden);
    await assert.rejects(publish(auth.ctx, "doc1", { public: true }), forbidden);
    await assert.doesNotReject(listPages({ ...auth.ctx, google: { ...failingGoogle(), listDocuments: async () => [] } }));
  });

  test("a commit-only key still cannot publish", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read", "pages:commit"] });
    const auth = await authenticateBearer(req(`Bearer ${key}`));
    assert.ok(auth.ok);
    if (!auth.ok) return;
    await assert.rejects(publish(auth.ctx, "doc1", { public: true }), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
  });

  test("revoking takes effect on the next request", async () => {
    const { key, record } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    assert.equal((await authenticateBearer(req(`Bearer ${key}`))).ok, true);
    await revokeApiKey("sub-a", record.id);
    const after = await authenticateBearer(req(`Bearer ${key}`));
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.status, 401);
  });

  test("missing, malformed and unknown credentials are 401", async () => {
    for (const header of [undefined, "Bearer nope", `Bearer pf_live_${randomBytes(32).toString("base64url")}`]) {
      const auth = await authenticateBearer(req(header));
      assert.equal(auth.ok, false);
      if (!auth.ok) assert.equal(auth.status, 401);
    }
  });

  test("a key whose owner disconnected Google cannot act", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"] });
    await query("DELETE FROM google_tokens");
    const auth = await authenticateBearer(req(`Bearer ${key}`));
    assert.equal(auth.ok, false);
  });

  test("a site-folder allow-list rides along in the context", async () => {
    const { key } = await createApiKey("sub-a", { name: "ci", scopes: ["pages:read"], siteFolders: ["1AbCdEfGhIjKl"] });
    const auth = await authenticateBearer(req(`Bearer ${key}`));
    assert.ok(auth.ok);
    if (auth.ok) assert.deepEqual(auth.ctx.siteFolders, ["1AbCdEfGhIjKl"]);
  });
});

function failingGoogle() {
  const fail = async () => {
    throw new Error("no Google call expected");
  };
  return { listDocuments: fail, fetchDocument: fail, createDocument: fail, batchUpdate: fail };
}
