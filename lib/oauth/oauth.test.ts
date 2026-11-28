import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { authenticateBearer } from "@/lib/api-auth";
import { saveGrant } from "@/lib/auth/server-sessions";
import { ServiceError, commit, publish } from "@/lib/service";
import { authorizationServerMetadata, challengeFor, parseRedirectUris, parseScopes, validRedirectUri, verifyPkce } from "./protocol";
import { exchangeCode, getClient, issueCode, refresh, registerClient, revokeAllForUser, revokeToken, verifyAccessToken } from "./store";

describe("protocol helpers", () => {
  test("redirect URIs must be https or loopback http, exact, with no fragment", () => {
    assert.equal(validRedirectUri("https://app.example/cb"), true);
    assert.equal(validRedirectUri("http://localhost:8123/cb"), true);
    assert.equal(validRedirectUri("http://127.0.0.1/cb"), true);
    assert.equal(validRedirectUri("http://evil.example/cb"), false);
    assert.equal(validRedirectUri("javascript:alert(1)"), false);
    assert.equal(validRedirectUri("https://app.example/cb#x"), false);
    assert.equal(validRedirectUri("https://user:pw@app.example/cb"), false);
    assert.equal(parseRedirectUris([]), null);
    assert.equal(parseRedirectUris(["https://a.example/1", "http://bad.example/2"]), null);
  });

  test("scopes default to read-only and reject unknown ones", () => {
    assert.deepEqual(parseScopes(""), ["pages:read"]);
    assert.deepEqual(parseScopes("pages:read pages:commit pages:read"), ["pages:read", "pages:commit"]);
    assert.equal(parseScopes("pages:read admin"), null);
  });

  test("PKCE S256 verifies only the matching verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = challengeFor(verifier);
    assert.equal(verifyPkce(verifier, challenge), true);
    assert.equal(verifyPkce(randomBytes(32).toString("base64url"), challenge), false);
    assert.equal(verifyPkce("short", challenge), false);
  });

  test("metadata advertises S256 and public clients only", () => {
    const meta = authorizationServerMetadata("https://app.example");
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
    assert.equal(meta.token_endpoint, "https://app.example/api/oauth/token");
  });
});

const url = testDatabaseUrl();
const verifier = randomBytes(32).toString("base64url");
const REDIRECT = "https://client.example/callback";

describe("authorization server", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
    await upsertUser("sub-a", "a@example.com");
  });
  beforeEach(async () => {
    await query("DELETE FROM oauth_clients");
    await query("DELETE FROM google_tokens");
    await saveGrant("sub-a", "a@example.com", { accessToken: "ya29.owner", refreshToken: "1//r", expiresInSeconds: 3600, scope: "openid drive.file" });
  });
  after(async () => {
    await closeDatabase();
  });

  async function authorizedTokens(scopes: ("pages:read" | "pages:commit" | "pages:publish")[] = ["pages:read"]) {
    const client = await registerClient("Test client", [REDIRECT]);
    const code = await issueCode({ clientId: client.clientId, sub: "sub-a", scopes, codeChallenge: challengeFor(verifier), redirectUri: REDIRECT });
    const result = await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: REDIRECT });
    assert.ok(result.ok);
    return { client, code, tokens: result.ok ? result.tokens : (null as never) };
  }

  test("a code with the right verifier yields tokens that verify with exactly the granted scopes", async () => {
    const { tokens, client } = await authorizedTokens();
    const access = await verifyAccessToken(tokens.access_token);
    assert.deepEqual(access, { sub: "sub-a", scopes: ["pages:read"], clientId: client.clientId, clientName: "Test client" });
    assert.equal(tokens.scope, "pages:read");
    assert.equal((await getClient(client.clientId))?.name, "Test client");
  });

  test("a wrong verifier, redirect URI or client is refused, and the code stays usable only once", async () => {
    const client = await registerClient("c", [REDIRECT]);
    const other = await registerClient("other", [REDIRECT]);
    const issue = () => issueCode({ clientId: client.clientId, sub: "sub-a", scopes: ["pages:read"], codeChallenge: challengeFor(verifier), redirectUri: REDIRECT });
    const bad = [
      { clientId: client.clientId, codeVerifier: randomBytes(32).toString("base64url"), redirectUri: REDIRECT },
      { clientId: client.clientId, codeVerifier: verifier, redirectUri: "https://client.example/other" },
      { clientId: other.clientId, codeVerifier: verifier, redirectUri: REDIRECT },
    ];
    for (const attempt of bad) assert.equal((await exchangeCode({ ...attempt, code: await issue() })).ok, false);
    const code = await issue();
    assert.equal((await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: REDIRECT })).ok, true);
    assert.equal((await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: REDIRECT })).ok, false);
  });

  test("replaying a used code revokes the tokens it issued", async () => {
    const { client, code, tokens } = await authorizedTokens();
    assert.ok(await verifyAccessToken(tokens.access_token));
    await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: REDIRECT });
    assert.equal(await verifyAccessToken(tokens.access_token), null);
  });

  test("an expired code is refused", async () => {
    const client = await registerClient("c", [REDIRECT]);
    const code = await issueCode({ clientId: client.clientId, sub: "sub-a", scopes: ["pages:read"], codeChallenge: challengeFor(verifier), redirectUri: REDIRECT });
    await query("UPDATE oauth_codes SET expires_at = now() - interval '1 second'");
    assert.equal((await exchangeCode({ clientId: client.clientId, code, codeVerifier: verifier, redirectUri: REDIRECT })).ok, false);
  });

  test("refresh rotates, and reusing a spent refresh token revokes the family", async () => {
    const { client, tokens } = await authorizedTokens();
    const next = await refresh({ clientId: client.clientId, refreshToken: tokens.refresh_token });
    assert.ok(next.ok);
    if (!next.ok) return;
    assert.equal(await verifyAccessToken(tokens.access_token), null);
    assert.ok(await verifyAccessToken(next.tokens.access_token));
    // The old refresh token is spent: presenting it again is theft, so everything in the family dies.
    assert.equal((await refresh({ clientId: client.clientId, refreshToken: tokens.refresh_token })).ok, false);
    assert.equal(await verifyAccessToken(next.tokens.access_token), null);
    assert.equal((await refresh({ clientId: client.clientId, refreshToken: next.tokens.refresh_token })).ok, false);
  });

  test("refresh cannot widen scope or change client", async () => {
    const { client, tokens } = await authorizedTokens();
    const stranger = await registerClient("stranger", [REDIRECT]);
    assert.equal((await refresh({ clientId: stranger.clientId, refreshToken: tokens.refresh_token })).ok, false);
    const next = await refresh({ clientId: client.clientId, refreshToken: tokens.refresh_token });
    assert.ok(next.ok);
    if (next.ok) assert.equal(next.tokens.scope, "pages:read");
  });

  test("revoking a refresh token ends the family; revoking an access token ends only it", async () => {
    const one = await authorizedTokens();
    await revokeToken(one.client.clientId, one.tokens.refresh_token);
    assert.equal(await verifyAccessToken(one.tokens.access_token), null);
    assert.equal((await refresh({ clientId: one.client.clientId, refreshToken: one.tokens.refresh_token })).ok, false);

    const two = await authorizedTokens();
    await revokeToken(two.client.clientId, two.tokens.access_token);
    assert.equal(await verifyAccessToken(two.tokens.access_token), null);
    assert.equal((await refresh({ clientId: two.client.clientId, refreshToken: two.tokens.refresh_token })).ok, true);
  });

  test("an expired access token stops working, and revokeAllForUser ends every token", async () => {
    const { tokens } = await authorizedTokens();
    await query("UPDATE oauth_tokens SET expires_at = now() - interval '1 second' WHERE kind = 'access'");
    assert.equal(await verifyAccessToken(tokens.access_token), null);
    const again = await authorizedTokens();
    await revokeAllForUser("sub-a");
    assert.equal(await verifyAccessToken(again.tokens.access_token), null);
  });

  test("only hashes are stored", async () => {
    const { tokens, code } = await authorizedTokens();
    const dump = JSON.stringify([await query("SELECT * FROM oauth_tokens"), await query("SELECT * FROM oauth_codes")]);
    for (const secret of [tokens.access_token, tokens.refresh_token, code]) assert.ok(!dump.includes(secret));
  });

  test("an OAuth access token authenticates as an MCP client with only its scopes", async () => {
    const { tokens } = await authorizedTokens(["pages:read"]);
    const auth = await authenticateBearer(new Request("https://app.example/api/v1/me", { headers: { authorization: `Bearer ${tokens.access_token}` } }));
    assert.ok(auth.ok);
    if (!auth.ok) return;
    assert.equal(auth.ctx.actor.client, "mcp");
    assert.equal(auth.ctx.googleToken, "ya29.owner");
    assert.equal(auth.credential.kind, "oauth");
    const forbidden = (err: unknown) => err instanceof ServiceError && err.code === "forbidden";
    await assert.rejects(commit(auth.ctx, "doc1", "r", []), forbidden);
    await assert.rejects(publish(auth.ctx, "doc1", { public: true }), forbidden);
  });
});
