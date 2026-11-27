import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { callerKey, sameOrigin, tooManyRequests } from "./guard";

function request(headers: Record<string, string>, url = "https://app.example/api/x"): Request {
  return new Request(url, { method: "POST", headers });
}

describe("sameOrigin", () => {
  test("trusts the browser's Sec-Fetch-Site", () => {
    assert.equal(sameOrigin(request({ "sec-fetch-site": "same-origin" })), true);
    assert.equal(sameOrigin(request({ "sec-fetch-site": "none" })), true);
  });

  test("refuses cross-site and same-site requests from another host", () => {
    assert.equal(sameOrigin(request({ "sec-fetch-site": "cross-site", origin: "https://evil.example" })), false);
    assert.equal(sameOrigin(request({ "sec-fetch-site": "same-site", origin: "https://other.app.example" })), false);
  });

  test("falls back to comparing Origin with the request host", () => {
    assert.equal(sameOrigin(request({ origin: "https://app.example" })), true);
    assert.equal(sameOrigin(request({ origin: "https://app.example.evil.example" })), false);
    assert.equal(sameOrigin(request({ origin: "null" })), false);
  });

  test("refuses a request with neither header", () => {
    assert.equal(sameOrigin(request({})), false);
  });
});

describe("callerKey", () => {
  test("hashes the token and never returns it", () => {
    const key = callerKey("secret-token", request({}));
    assert.equal(key.length, 24);
    assert.ok(!key.includes("secret-token"));
    assert.equal(key, callerKey("secret-token", request({ "x-forwarded-for": "203.0.113.9" })));
  });

  test("prefers the Google account, so a refreshed token keeps the same budget", () => {
    const first = callerKey("token-a", request({}), "sub-1");
    assert.equal(first, callerKey("token-b", request({}), "sub-1"));
    assert.match(first, /^sub:[0-9a-f]{24}$/);
    assert.ok(!first.includes("sub-1"));
  });

  test("uses the first forwarded address when signed out", () => {
    assert.equal(callerKey(null, request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "ip:203.0.113.9");
    assert.equal(callerKey(null, request({})), "ip:local");
  });

  test("caps the length of a forwarded address", () => {
    const key = callerKey(null, request({ "x-forwarded-for": "a".repeat(500) }));
    assert.equal(key, `ip:${"a".repeat(64)}`);
  });
});

describe("tooManyRequests", () => {
  test("sets status 429, Retry-After and RateLimit-* headers", async () => {
    const res = tooManyRequests("Slow down.", { ok: false, limit: 6, remaining: 0, resetSeconds: 12, retryAfterSeconds: 12 });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "12");
    assert.equal(res.headers.get("ratelimit-limit"), "6");
    assert.equal(res.headers.get("ratelimit-remaining"), "0");
    assert.equal(res.headers.get("ratelimit-reset"), "12");
    assert.deepEqual(await res.json(), { error: "Slow down." });
  });
});
