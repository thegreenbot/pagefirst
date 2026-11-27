// MCP sign-in (#36): metadata, dynamic registration, consent, token exchange, bearer API.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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

const REDIRECT = "https://client.example/callback";

describe("OAuth 2.1 for MCP clients", { skip: dbUrl ? false : "set TEST_DATABASE_URL to run" }, () => {
  let app;
  before(async () => {
    await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    app = await startApp({ google: true, env: { DATABASE_URL: dbUrl, TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64") } });
  });
  after(async () => {
    await app?.stop();
  });

  async function signIn(returnTo) {
    const start = await fetch(`${app.base}/api/auth/google${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ""}`, { redirect: "manual" });
    const location = new URL(start.headers.get("location"));
    const jar = cookiesFrom(start);
    const res = await fetch(`${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(location.searchParams.get("state"))}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    return { cookie: `pf_session=${cookiesFrom(res).pf_session}`, location: res.headers.get("location") };
  }

  async function register() {
    const res = await fetch(`${app.base}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Test <b>client</b>", redirect_uris: [REDIRECT] }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).client_id;
  }

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorizeQuery = (clientId, extra = {}) =>
    new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", scope: "pages:read", state: "xyz", ...extra });

  test("metadata documents the endpoints and allows cross-origin reads", async () => {
    const res = await fetch(`${app.base}/.well-known/oauth-authorization-server`);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const meta = await res.json();
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    const resource = await (await fetch(`${app.base}/.well-known/oauth-protected-resource`)).json();
    assert.equal(resource.authorization_servers[0], meta.issuer);
  });

  test("registration refuses insecure redirect URIs", async () => {
    const res = await fetch(`${app.base}/api/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    assert.equal(res.status, 400);
  });

  test("the consent screen never redirects to an unregistered redirect URI", async () => {
    const clientId = await register();
    const res = await fetch(`${app.base}/oauth/authorize?${authorizeQuery(clientId, { redirect_uri: "https://evil.example/cb" })}`, { redirect: "manual" });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  });

  test("signed out, the consent screen offers sign-in and returns to itself afterwards", async () => {
    const clientId = await register();
    const query = authorizeQuery(clientId).toString();
    const res = await fetch(`${app.base}/oauth/authorize?${query}`);
    const html = await res.text();
    assert.match(html, /Sign in with Google/);
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    const { location } = await signIn(`/oauth/authorize?${query}`);
    assert.equal(new URL(location).pathname, "/oauth/authorize");
  });

  test("a return address outside the consent screen is ignored", async () => {
    const { location } = await signIn("https://evil.example/");
    assert.equal(new URL(location).pathname, "/");
  });

  test("full flow: consent, code, tokens, bearer call, refresh, revoke", async () => {
    const clientId = await register();
    const { cookie } = await signIn();
    const query = authorizeQuery(clientId);
    const page = await (await fetch(`${app.base}/oauth/authorize?${query}`, { headers: { cookie } })).text();
    assert.match(page, /Allow Test &lt;b&gt;client&lt;\/b&gt;\?/, "client name is escaped");
    assert.doesNotMatch(page, /<b>client/);

    const cross = await fetch(`${app.base}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve" }),
    });
    assert.equal(cross.status, 403, "cross-site consent is refused");

    const approve = await fetch(`${app.base}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ ...Object.fromEntries(query), decision: "approve" }),
    });
    const html = await approve.text();
    const target = new URL(/url=([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&"));
    assert.equal(target.origin + target.pathname, REDIRECT);
    assert.equal(target.searchParams.get("state"), "xyz");
    const code = target.searchParams.get("code");

    const token = (params) =>
      fetch(`${app.base}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    const bad = await token({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") });
    assert.equal(bad.status, 400);

    const good = await token({ grant_type: "authorization_code", client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier });
    // The failed attempt did not burn the code, so a correct one still works.
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("cache-control"), "no-store");
    const tokens = await good.json();

    const me = await fetch(`${app.base}/api/v1/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).scopes, ["pages:read"]);
    assert.equal((await fetch(`${app.base}/api/v1/me`)).status, 401);

    const rotated = await (await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })).json();
    assert.ok(rotated.access_token);
    assert.equal((await fetch(`${app.base}/api/v1/me`, { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401, "old access token is dead");

    await fetch(`${app.base}/api/oauth/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, token: rotated.refresh_token }) });
    assert.equal((await fetch(`${app.base}/api/v1/me`, { headers: { authorization: `Bearer ${rotated.access_token}` } })).status, 401);
  });

  test("an API key works on /api/v1/me and stops the moment it is revoked", async () => {
    const { cookie } = await signIn();
    const headers = { cookie, "content-type": "application/json", "sec-fetch-site": "same-origin" };
    const created = await (await fetch(`${app.base}/api/keys`, { method: "POST", headers, body: JSON.stringify({ name: "ci", scopes: ["pages:read"] }) })).json();
    const auth = { authorization: `Bearer ${created.key}` };
    assert.equal((await fetch(`${app.base}/api/v1/me`, { headers: auth })).status, 200);
    const revoke = await fetch(`${app.base}/api/keys/${created.record.id}`, { method: "DELETE", headers });
    assert.equal(revoke.status, 200);
    assert.equal((await fetch(`${app.base}/api/v1/me`, { headers: auth })).status, 401);
    const cross = await fetch(`${app.base}/api/keys`, { method: "POST", headers: { ...headers, "sec-fetch-site": "cross-site" }, body: "{}" });
    assert.equal(cross.status, 403);
  });
});
