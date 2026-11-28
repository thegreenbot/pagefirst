import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildAuthUrl, createPkce, exchangeCode, refreshAccessToken, revokeToken } from "./oauth";
import { googleConfigured } from "./config";

const saved = { ...process.env };
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
});

afterEach(() => {
  process.env = { ...saved };
  globalThis.fetch = realFetch;
});

describe("googleConfigured", () => {
  test("needs both the client id and secret", () => {
    assert.equal(googleConfigured(), true);
    process.env.GOOGLE_CLIENT_SECRET = "";
    assert.equal(googleConfigured(), false);
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_ID = "client-id";
    assert.equal(googleConfigured(), false);
  });
});

describe("createPkce", () => {
  test("returns fresh, high-entropy base64url values", () => {
    const a = createPkce();
    const b = createPkce();
    assert.notEqual(a.verifier, b.verifier);
    assert.notEqual(a.state, b.state);
    assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.match(a.state, /^[A-Za-z0-9_-]{43}$/);
  });
});

describe("buildAuthUrl", () => {
  test("sends the S256 challenge of the verifier, never the verifier", () => {
    const url = new URL(buildAuthUrl({ origin: "https://app.example", state: "s1", verifier: "v1" }));
    assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(url.searchParams.get("client_id"), "client-id");
    assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/api/auth/callback");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("state"), "s1");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(
      url.searchParams.get("code_challenge"),
      createHash("sha256").update("v1").digest("base64url"),
    );
    assert.ok(!url.toString().includes("v1&") && !url.toString().endsWith("v1"));
    assert.ok(!url.toString().includes("client-secret"));
  });

  test("asks for offline access only when requested", () => {
    const online = new URL(buildAuthUrl({ origin: "https://a", state: "s", verifier: "v" }));
    assert.equal(online.searchParams.get("access_type"), null);
    const offline = new URL(buildAuthUrl({ origin: "https://a", state: "s", verifier: "v", offline: true }));
    assert.equal(offline.searchParams.get("access_type"), "offline");
    assert.equal(offline.searchParams.get("prompt"), "consent");
  });

  test("asks only for Docs and per-file Drive access", () => {
    const scopes = new URL(buildAuthUrl({ origin: "https://a", state: "s", verifier: "v" }))
      .searchParams.get("scope")!
      .split(" ");
    assert.deepEqual(scopes.sort(), [
      "email",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.file",
      "openid",
      "profile",
    ]);
  });
});

describe("exchangeCode", () => {
  function stubFetch(response: Response): { calls: { url: string; body: URLSearchParams }[] } {
    const calls: { url: string; body: URLSearchParams }[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body)) });
      return response;
    }) as typeof fetch;
    return { calls };
  }

  test("posts the code, verifier and redirect URI and returns the access token", async () => {
    const { calls } = stubFetch(Response.json({ access_token: "at-1" }));
    const result = await exchangeCode({ origin: "https://app.example", code: "c1", verifier: "v1" });
    assert.deepEqual(result, { accessToken: "at-1", refreshToken: null, expiresInSeconds: 3600, scope: "" });
    assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
    const body = calls[0].body;
    assert.equal(body.get("code"), "c1");
    assert.equal(body.get("code_verifier"), "v1");
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("redirect_uri"), "https://app.example/api/auth/callback");
    assert.equal(body.get("client_secret"), "client-secret");
  });

  test("returns the refresh token, lifetime and scopes when Google sends them", async () => {
    stubFetch(Response.json({ access_token: "at", refresh_token: "rt", expires_in: 1200, scope: "openid drive.file" }));
    assert.deepEqual(await exchangeCode({ origin: "https://a", code: "c", verifier: "v" }), {
      accessToken: "at",
      refreshToken: "rt",
      expiresInSeconds: 1200,
      scope: "openid drive.file",
    });
  });

  test("refreshAccessToken sends a refresh_token grant", async () => {
    const { calls } = stubFetch(Response.json({ access_token: "at-2", expires_in: 3599 }));
    const result = await refreshAccessToken("rt-1");
    assert.equal(result.accessToken, "at-2");
    assert.equal(calls[0].body.get("grant_type"), "refresh_token");
    assert.equal(calls[0].body.get("refresh_token"), "rt-1");
  });

  test("revokeToken posts the token and reports success; network errors return false", async () => {
    const { calls } = stubFetch(new Response("", { status: 200 }));
    assert.equal(await revokeToken("rt-1"), true);
    assert.equal(calls[0].url, "https://oauth2.googleapis.com/revoke");
    assert.equal(calls[0].body.get("token"), "rt-1");
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await revokeToken("rt-1"), false);
  });

  test("throws on an error status without echoing the response", async () => {
    stubFetch(Response.json({ error: "invalid_grant", detail: "client-secret" }, { status: 400 }));
    await assert.rejects(exchangeCode({ origin: "https://a", code: "c", verifier: "v" }), (err: Error) => {
      assert.equal(err.message, "400");
      return true;
    });
  });

  test("throws when the response has no access token", async () => {
    stubFetch(Response.json({ access_token: "" }));
    await assert.rejects(exchangeCode({ origin: "https://a", code: "c", verifier: "v" }), /No access token/);
  });
});

describe("googleScopes (#15)", () => {
  test("narrow mode asks for drive.file and identity only", async () => {
    const { googleScopes } = await import("./oauth");
    const narrow = googleScopes("narrow");
    assert.deepEqual(narrow, ["openid", "email", "profile", "https://www.googleapis.com/auth/drive.file"]);
    assert.equal(googleScopes(undefined).length, narrow.length + 1);
  });
});
