import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { cookieHeader, cookiesFrom, startApp } from "./server.mjs";

describe("Google OAuth routes", () => {
  let app;
  before(async () => {
    app = await startApp({ google: true });
  });
  after(async () => {
    await app?.stop();
  });

  async function beginSignIn() {
    const res = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
    assert.equal(res.status, 307);
    const location = new URL(res.headers.get("location"));
    const jar = cookiesFrom(res);
    return { location, jar };
  }

  test("sign-in redirects to Google with state, S256 PKCE and the scoped grant", async () => {
    const { location, jar } = await beginSignIn();
    assert.equal(location.host, "accounts.google.com");
    assert.equal(location.searchParams.get("code_challenge_method"), "S256");
    assert.ok(location.searchParams.get("code_challenge"));
    assert.equal(location.searchParams.get("state"), jar.pf_state);
    assert.ok(jar.pf_verifier, "verifier cookie is set");
    assert.notEqual(location.searchParams.get("code_challenge"), jar.pf_verifier, "verifier never leaves the server");
    assert.equal(
      location.searchParams.get("redirect_uri"),
      `${app.base}/api/auth/callback`,
    );
    const scopes = location.searchParams.get("scope").split(" ");
    assert.ok(scopes.includes("https://www.googleapis.com/auth/drive.file"));
    assert.ok(!scopes.includes("https://www.googleapis.com/auth/drive"), "never asks for full Drive");
  });

  test("callback with matching state and a good code sets the session and clears PKCE", async () => {
    const { location, jar } = await beginSignIn();
    const state = location.searchParams.get("state");
    const res = await fetch(`${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location")).pathname, "/");
    assert.equal(new URL(res.headers.get("location")).search, "");
    const set = cookiesFrom(res);
    assert.equal(set.pf_access, "fake-token");
    assert.equal(set.pf_state, "", "state cookie cleared");
    assert.equal(set.pf_verifier, "", "verifier cookie cleared");
    const raw = res.headers.getSetCookie().find((line) => line.startsWith("pf_access="));
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=lax/i);
  });

  test("callback with a state that does not match is refused", async () => {
    const { jar } = await beginSignIn();
    const res = await fetch(`${app.base}/api/auth/callback?code=good&state=forged`, {
      redirect: "manual",
      headers: { cookie: cookieHeader(jar) },
    });
    assert.equal(res.status, 307);
    assert.equal(new URL(res.headers.get("location")).search, "?google=error");
    assert.equal(cookiesFrom(res).pf_access, undefined);
  });

  test("callback without the verifier cookie is refused", async () => {
    const { location, jar } = await beginSignIn();
    const state = location.searchParams.get("state");
    const res = await fetch(`${app.base}/api/auth/callback?code=good&state=${encodeURIComponent(state)}`, {
      redirect: "manual",
      headers: { cookie: cookieHeader({ pf_state: jar.pf_state }) },
    });
    assert.equal(new URL(res.headers.get("location")).search, "?google=error");
    assert.equal(cookiesFrom(res).pf_access, undefined);
  });

  test("callback without a code or state is refused", async () => {
    const { jar } = await beginSignIn();
    for (const query of ["", "?code=good", `?state=${jar.pf_state}`]) {
      const res = await fetch(`${app.base}/api/auth/callback${query}`, {
        redirect: "manual",
        headers: { cookie: cookieHeader(jar) },
      });
      assert.equal(new URL(res.headers.get("location")).search, "?google=error", query);
      assert.equal(cookiesFrom(res).pf_access, undefined, query);
    }
  });

  for (const code of ["fail", "empty"]) {
    test(`callback is refused when the token exchange ${code === "fail" ? "fails" : "returns no token"}`, async () => {
      const { location, jar } = await beginSignIn();
      const state = location.searchParams.get("state");
      const res = await fetch(`${app.base}/api/auth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
        redirect: "manual",
        headers: { cookie: cookieHeader(jar) },
      });
      assert.equal(new URL(res.headers.get("location")).search, "?google=error");
      const set = cookiesFrom(res);
      assert.equal(set.pf_access, undefined);
      assert.equal(set.pf_verifier, "", "PKCE cleared after a failed exchange");
    });
  }

  test("logout clears the session cookie", async () => {
    const res = await fetch(`${app.base}/api/auth/logout`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: "pf_access=fake-token", origin: app.base },
    });
    assert.ok(res.status === 303 || res.status === 307, `status ${res.status}`);
    assert.equal(cookiesFrom(res).pf_access, "");
  });
});

describe("Google OAuth routes without credentials", () => {
  let app;
  before(async () => {
    app = await startApp({ google: false });
  });
  after(async () => {
    await app?.stop();
  });

  test("sign-in sends the user back to sample mode", async () => {
    const res = await fetch(`${app.base}/api/auth/google`, { redirect: "manual" });
    assert.equal(new URL(res.headers.get("location")).search, "?google=unconfigured");
    assert.equal(cookiesFrom(res).pf_state, undefined);
  });
});
