import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { checkMutation, isJsonContentType, isJsonRoute, sameOrigin } from "./csrf";

const COMMIT = "/api/pages/doc1/commit";

function request(method: string, headers: Record<string, string>, body?: string): Request {
  return new Request(`https://app.example${COMMIT}`, { method, headers, body });
}

describe("sameOrigin", () => {
  const saved = process.env.APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });

  test("accepts Origin matching APP_URL when the proxy rewrote the host", () => {
    process.env.APP_URL = "https://pages.example/";
    const req = new Request("http://internal:3847/api/x", { method: "POST", headers: { origin: "https://pages.example" } });
    assert.equal(sameOrigin(req), true);
    const evil = new Request("http://internal:3847/api/x", { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(sameOrigin(evil), false);
  });

  test("ignores a malformed APP_URL and a malformed Origin", () => {
    process.env.APP_URL = "not a url";
    assert.equal(sameOrigin(request("POST", { origin: "https://evil.example" })), false);
    assert.equal(sameOrigin(request("POST", { origin: "::::" })), false);
  });
});

describe("checkMutation", () => {
  test("lets safe methods through without any headers", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      assert.deepEqual(checkMutation(request(method, {}), COMMIT), { ok: true });
    }
  });

  test("refuses a cross-site text/plain POST to commit with 403", () => {
    const verdict = checkMutation(
      request("POST", { "sec-fetch-site": "cross-site", origin: "https://evil.example", "content-type": "text/plain" }, "{}"),
      COMMIT,
    );
    assert.equal(verdict.ok, false);
    assert.equal(!verdict.ok && verdict.status, 403);
  });

  test("refuses a POST that carries no origin signal at all", () => {
    const verdict = checkMutation(request("POST", { "content-type": "application/json" }, "{}"), COMMIT);
    assert.equal(!verdict.ok && verdict.status, 403);
  });

  test("refuses a same-origin non-JSON body on a JSON route with 415", () => {
    const verdict = checkMutation(
      request("POST", { "sec-fetch-site": "same-origin", "content-type": "text/plain" }, "{}"),
      COMMIT,
    );
    assert.equal(!verdict.ok && verdict.status, 415);
  });

  test("accepts a same-origin JSON commit, and an empty-bodied publish", () => {
    assert.deepEqual(
      checkMutation(request("POST", { "sec-fetch-site": "same-origin", "content-type": "application/json; charset=utf-8" }, "{}"), COMMIT),
      { ok: true },
    );
    assert.deepEqual(
      checkMutation(request("POST", { "sec-fetch-site": "same-origin" }), "/api/pages/doc1/publish"),
      { ok: true },
    );
  });

  test("does not demand JSON from form routes such as logout and media", () => {
    const form = request("POST", { origin: "https://app.example", "content-type": "application/x-www-form-urlencoded" }, "a=b");
    assert.deepEqual(checkMutation(form, "/api/auth/logout"), { ok: true });
    assert.deepEqual(checkMutation(form, "/api/media"), { ok: true });
  });
});

describe("route helpers", () => {
  test("isJsonRoute matches only commit and publish", () => {
    assert.equal(isJsonRoute("/api/pages/a/commit"), true);
    assert.equal(isJsonRoute("/api/pages/a/publish"), true);
    assert.equal(isJsonRoute("/api/media"), false);
    assert.equal(isJsonRoute("/api/pages/a/commit/extra"), false);
  });

  test("isJsonContentType ignores parameters and case", () => {
    assert.equal(isJsonContentType("Application/JSON; charset=utf-8"), true);
    assert.equal(isJsonContentType("text/plain"), false);
    assert.equal(isJsonContentType(null), false);
  });
});
