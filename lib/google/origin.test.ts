import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { GET as startGoogle } from "../../app/api/auth/google/route";
import { buildAuthUrl } from "./oauth";
import { callbackUrl, oauthOrigin, oauthOriginFromHeaders } from "./origin";

const APP = "https://pagefirst.example.com";
const APP_REDIRECT_URI = `${APP}/api/auth/callback`;
const PREVIEW = "https://pagefirst-git-branch-team.vercel.app";

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
  nextUrl: { origin: PREVIEW, hostname: "pagefirst-git-branch-team.vercel.app" },
};

test("APP_URL is used without a trailing slash", () => {
  withEnv("APP_URL", `${APP}/`, () => {
    assert.equal(oauthOrigin(vercelRequest), APP);
    assert.equal(callbackUrl(oauthOrigin(vercelRequest)), APP_REDIRECT_URI);
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

test("without APP_URL a vercel.app host keeps its own https origin, never another site's", () => {
  withEnv("APP_URL", undefined, () => {
    assert.equal(oauthOrigin(vercelRequest), PREVIEW);
    assert.equal(
      oauthOrigin({ nextUrl: { origin: "http://Foo.Vercel.app", hostname: "Foo.Vercel.app" } }),
      "https://foo.vercel.app",
    );
  });
});

test("localhost keeps the request origin", () => {
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
      oauthOrigin({ nextUrl: { origin: "https://vercel.app", hostname: "vercel.app" } }),
      "https://vercel.app",
    );
  });
});

test("authorize redirect_uri matches the token exchange callback", () => {
  withEnv("GOOGLE_CLIENT_ID", "test-client", () => {
    const url = new URL(buildAuthUrl({ origin: APP, state: "state", verifier: "verifier" }));
    assert.equal(url.searchParams.get("redirect_uri"), APP_REDIRECT_URI);
  });
});

test("session cookie is secure on Vercel and https, not on plain localhost", () => {
  withEnv("APP_URL", undefined, () => {
    const vercel = oauthOriginFromHeaders(new Headers({ host: "pagefirst-git-branch-team.vercel.app", "x-forwarded-proto": "http" }));
    const local = oauthOriginFromHeaders(new Headers({ host: "127.0.0.1:3847" }));
    const forwarded = oauthOriginFromHeaders(new Headers({ host: "127.0.0.1:3847", "x-forwarded-proto": "https" }));
    assert.equal(vercel, PREVIEW);
    assert.equal(local, "http://127.0.0.1:3847");
    assert.equal(forwarded, "https://127.0.0.1:3847");
  });
});

test("route redirects stay on the vercel.app host that was asked", async () => {
  const vercel = new NextRequest(`${PREVIEW}/api/auth/google`);
  const local = new NextRequest("http://localhost:3847/api/auth/google");
  await withEnvAsync("GOOGLE_CLIENT_ID", undefined, async () => {
    await withEnvAsync("GOOGLE_CLIENT_SECRET", undefined, async () => {
      await withEnvAsync("APP_URL", undefined, async () => {
        const response = await startGoogle(vercel);
        assert.equal(response.headers.get("location"), `${PREVIEW}/?google=unconfigured`);
        const localResponse = await startGoogle(local);
        assert.equal(localResponse.headers.get("location"), "http://localhost:3847/?google=unconfigured");
      });
    });
  });
});

test("APP_URL still wins when the request host is read from headers", () => {
  withEnv("APP_URL", "https://example.com/", () => {
    assert.equal(oauthOriginFromHeaders(new Headers({ host: "pagefirst-git-branch-team.vercel.app" })), "https://example.com");
  });
});
