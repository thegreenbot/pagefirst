import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { fetchGoogleIdentity } from "./userinfo";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respond(body: unknown, status = 200) {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("fetchGoogleIdentity", () => {
  test("returns sub and a lower-cased verified email", async () => {
    respond({ sub: "123", email: "Will@Example.com", email_verified: true });
    assert.deepEqual(await fetchGoogleIdentity("t"), { sub: "123", email: "will@example.com" });
  });

  test("drops an unverified email", async () => {
    respond({ sub: "123", email: "will@example.com", email_verified: false });
    assert.deepEqual(await fetchGoogleIdentity("t"), { sub: "123", email: null });
  });

  test("returns null when Google refuses the token or the body has no sub", async () => {
    respond({ error: "invalid" }, 401);
    assert.equal(await fetchGoogleIdentity("t"), null);
    respond({ email: "x@example.com" });
    assert.equal(await fetchGoogleIdentity("t"), null);
  });

  test("returns null on a network error", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    assert.equal(await fetchGoogleIdentity("t"), null);
  });
});
