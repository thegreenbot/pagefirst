import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { callerKey, checkRateLimit, sameOrigin, tooManyRequests, withinRateLimit } from "./guard";

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

  test("uses the first forwarded address when signed out", () => {
    assert.equal(callerKey(null, request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "ip:203.0.113.9");
    assert.equal(callerKey(null, request({})), "ip:local");
  });

  test("caps the length of a forwarded address", () => {
    const key = callerKey(null, request({ "x-forwarded-for": "a".repeat(500) }));
    assert.equal(key, `ip:${"a".repeat(64)}`);
  });
});

describe("withinRateLimit", () => {
  test("allows `limit` calls a minute per key, then refuses", () => {
    const key = `test:${Math.random()}`;
    const results = Array.from({ length: 4 }, () => withinRateLimit(key, 3));
    assert.deepEqual(results, [true, true, true, false]);
    assert.equal(withinRateLimit(`${key}:other`, 3), true, "keys are independent");
  });

  test("frees a slot once a minute has passed", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const key = `test:${Math.random()}`;
    assert.equal(withinRateLimit(key, 1), true);
    assert.equal(withinRateLimit(key, 1), false);
    t.mock.timers.tick(60_001);
    assert.equal(withinRateLimit(key, 1), true);
  });
});

describe("checkRateLimit", () => {
  test("says how many seconds until the oldest call leaves the window", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
    const key = `test:${Math.random()}`;
    assert.deepEqual(checkRateLimit(key, 1), { ok: true });
    t.mock.timers.tick(15_000);
    assert.deepEqual(checkRateLimit(key, 1), { ok: false, retryAfterSeconds: 45 });
  });

  test("tooManyRequests sets status 429 and Retry-After", async () => {
    const res = tooManyRequests("Slow down.", 12);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "12");
    assert.deepEqual(await res.json(), { error: "Slow down." });
  });
});
