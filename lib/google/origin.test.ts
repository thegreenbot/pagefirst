import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as startGoogle } from "../../app/api/auth/google/route";
import { buildAuthUrl } from "./oauth";
import { callbackUrl, oauthOrigin, oauthOriginFromHeaders, PUBLIC_APP_ORIGIN } from "./origin";

const LIVE_REDIRECT_URI = "https://page-first.apps.grok.bot/api/auth/callback";

function withEnv(name: string, value: string | undefined, run: () => void) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

async function withEnvAsync(
  name: string,
  value: string | undefined,
  run: () => Promise<void>,
) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

const vercelRequest = {
  nextUrl: {
    origin: "https://page-first-abc123.vercel.app",
    hostname: "page-first-abc123.vercel.app",
  },
};

test("APP_URL is used without a trailing slash", () => {
  withEnv("APP_URL", "https://page-first.apps.grok.bot/", () => {
    assert.equal(oauthOrigin(vercelRequest), PUBLIC_APP_ORIGIN);
    assert.equal(callbackUrl(oauthOrigin(vercelRequest)), LIVE_REDIRECT_URI);
  });
});

test("a blank APP_URL does not override the request", () => {
  withEnv("APP_URL", "   ", () => {
    assert.equal(
      oauthOrigin({ nextUrl: { origin: "http://127.0.0.1:3847", hostname: "127.0.0.1" } }),
      "http://127.0.0.1:3847",
    );
  });
});

test("a vercel.app host uses the public app origin", () => {
  withEnv("APP_URL", undefined, () => {
    assert.equal(oauthOrigin(vercelRequest), PUBLIC_APP_ORIGIN);
    assert.equal(callbackUrl(PUBLIC_APP_ORIGIN), LIVE_REDIRECT_URI);
    assert.equal(
      oauthOrigin({
        nextUrl: { origin: "https://Vercel.app", hostname: "foo.Vercel.app" },
      }),
      PUBLIC_APP_ORIGIN,
    );
  });
});

test("localhost and the public host keep the request origin", () => {
  withEnv("APP_URL", undefined, () => {
    assert.equal(
      oauthOrigin({ nextUrl: { origin: "http://127.0.0.1:3847", hostname: "127.0.0.1" } }),
      "http://127.0.0.1:3847",
    );
    assert.equal(
      oauthOrigin({ nextUrl: { origin: "http://localhost:3847", hostname: "localhost" } }),
      "http://localhost:3847",
    );
    assert.equal(
      oauthOrigin({
        nextUrl: { origin: PUBLIC_APP_ORIGIN, hostname: "page-first.apps.grok.bot" },
      }),
      PUBLIC_APP_ORIGIN,
    );
    assert.equal(
      oauthOrigin({ nextUrl: { origin: "https://vercel.app", hostname: "vercel.app" } }),
      "https://vercel.app",
    );
  });
});

test("authorize redirect_uri matches the token exchange callback", () => {
  withEnv("GOOGLE_CLIENT_ID", "test-client", () => {
    const url = new URL(
      buildAuthUrl({ origin: PUBLIC_APP_ORIGIN, state: "state", verifier: "verifier" }),
    );
    assert.equal(url.searchParams.get("redirect_uri"), LIVE_REDIRECT_URI);
    assert.equal(callbackUrl(PUBLIC_APP_ORIGIN), LIVE_REDIRECT_URI);
  });
});

test("session cookie is secure for the public app and not for localhost", () => {
  withEnv("APP_URL", undefined, () => {
    const vercel = oauthOriginFromHeaders(new Headers({ host: "page-first-abc123.vercel.app" }));
    const local = oauthOriginFromHeaders(new Headers({ host: "127.0.0.1:3847" }));
    const forwarded = oauthOriginFromHeaders(
      new Headers({ host: "127.0.0.1:3847", "x-forwarded-proto": "https" }),
    );
    const publicHost = oauthOriginFromHeaders(new Headers({ host: "page-first.apps.grok.bot" }));
    const publicHostHttp = oauthOriginFromHeaders(
      new Headers({ host: "page-first.apps.grok.bot", "x-forwarded-proto": "http" }),
    );
    assert.equal(vercel, PUBLIC_APP_ORIGIN);
    assert.equal(vercel.startsWith("https://"), true);
    assert.equal(local, "http://127.0.0.1:3847");
    assert.equal(local.startsWith("https://"), false);
    assert.equal(forwarded, "https://127.0.0.1:3847");
    assert.equal(publicHost, PUBLIC_APP_ORIGIN);
    assert.equal(publicHostHttp, PUBLIC_APP_ORIGIN);
  });
});

test("route redirects use the public origin for a vercel.app request", async () => {
  const vercel = new NextRequest("https://page-first-abc123.vercel.app/api/auth/google");
  const local = new NextRequest("http://localhost:3847/api/auth/google");
  assert.equal(vercel.nextUrl.hostname, "page-first-abc123.vercel.app");
  assert.equal(oauthOrigin(vercel), PUBLIC_APP_ORIGIN);
  assert.equal(oauthOrigin(local), "http://localhost:3847");

  await withEnvAsync("GOOGLE_CLIENT_ID", undefined, async () => {
    await withEnvAsync("GOOGLE_CLIENT_SECRET", undefined, async () => {
      await withEnvAsync("APP_URL", undefined, async () => {
        const response = await startGoogle(vercel);
        assert.equal(
          response.headers.get("location"),
          "https://page-first.apps.grok.bot/?google=unconfigured",
        );
        const localResponse = await startGoogle(local);
        assert.equal(localResponse.headers.get("location"), "http://localhost:3847/?google=unconfigured");
      });
    });
  });
});

test("APP_URL still wins when the request host is read from headers", () => {
  withEnv("APP_URL", "https://example.com/", () => {
    assert.equal(
      oauthOriginFromHeaders(new Headers({ host: "page-first-abc123.vercel.app" })),
      "https://example.com",
    );
  });
});
