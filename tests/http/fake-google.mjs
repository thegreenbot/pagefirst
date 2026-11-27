// Preloaded into the Next server under test (NODE_OPTIONS=--import). Answers
// Google OAuth, Docs and Drive calls in-process so route handlers can be
// exercised end to end without a network or a Google account.
//
// Behaviour is keyed on inputs, so tests stay independent:
// - token endpoint: code "good" succeeds (with a refresh token), refresh grants with it succeed, "fail" returns 400, "empty" returns no token.
// - Docs: "missing" is 404, "boom" is 500, any other id is a document at revision "rev-2".
// - userinfo: sub "fake-sub", verified email "Author@Example.com".
// - Every Docs or Drive call must carry "Bearer fake-token", or it gets 401.

export const FAKE_TOKEN = "fake-token";
export const FAKE_REFRESH = "fake-refresh-token";
const realFetch = globalThis.fetch;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function bearer(init, input) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return headers.get("authorization");
}

async function bodyText(init, input) {
  if (init?.body !== undefined) return String(init.body);
  if (input instanceof Request) return input.text();
  return "";
}

function liveDoc(id) {
  return { documentId: id, title: "Live doc", revisionId: "rev-2", body: { content: [] } };
}

globalThis.fetch = async function fakeGoogleFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();

  if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams(await bodyText(init, input));
    if (form.get("client_secret") !== process.env.GOOGLE_CLIENT_SECRET) {
      return json({ error: "invalid_client" }, 401);
    }
    if (form.get("grant_type") === "refresh_token") {
      if (form.get("refresh_token") === FAKE_REFRESH) return json({ access_token: FAKE_TOKEN, expires_in: 3600 });
      return json({ error: "invalid_grant" }, 400);
    }
    if (!form.get("code_verifier")) return json({ error: "invalid_grant" }, 400);
    const code = form.get("code");
    if (code === "good") {
      return json({ access_token: FAKE_TOKEN, refresh_token: FAKE_REFRESH, expires_in: 3600, scope: "openid email drive.file" });
    }
    if (code === "empty") return json({});
    return json({ error: "invalid_grant" }, 400);
  }

  if (url.host === "oauth2.googleapis.com" && url.pathname === "/revoke") {
    return new Response("", { status: 200 });
  }

  if (url.host === "openidconnect.googleapis.com" && url.pathname === "/v1/userinfo") {
    if (bearer(init, input) !== `Bearer ${FAKE_TOKEN}`) return json({ error: "unauthenticated" }, 401);
    return json({ sub: "fake-sub", email: "Author@Example.com", email_verified: true });
  }

  if (url.host === "docs.googleapis.com" || url.host === "www.googleapis.com") {
    if (bearer(init, input) !== `Bearer ${FAKE_TOKEN}`) return json({ error: "unauthenticated" }, 401);

    if (url.host === "www.googleapis.com" && url.pathname === "/drive/v3/files") {
      return json({ files: [{ id: "doc1", name: "Doc one" }] });
    }

    const match = url.pathname.match(/^\/v1\/documents(?:\/([^/:]+))?(:batchUpdate)?$/);
    if (match) {
      const id = match[1] ? decodeURIComponent(match[1]) : undefined;
      if (id === "missing") return json({ error: "not found" }, 404);
      if (id === "boom") return json({ error: "backend" }, 500);
      if (!id && method === "POST") return json(liveDoc("created"));
      if (id && match[2]) return json({ replies: [] });
      if (id) return json(liveDoc(id));
    }
    return json({ error: "unexpected Google call in test" }, 500);
  }

  // R2 object writes (#94): accepted when they carry the bucket token "fake-r2-token".
  if (url.host === "api.cloudflare.com" && /\/r2\/buckets\/[^/]+\/objects\//.test(url.pathname)) {
    if (bearer(init, input) !== "Bearer fake-r2-token") return json({ success: false }, 403);
    return json({ success: true });
  }

  if (url.host.endsWith("cloudflare.com")) {
    return json({ success: false, errors: [{ message: "no network in tests" }] }, 500);
  }

  return realFetch(input, init);
};
