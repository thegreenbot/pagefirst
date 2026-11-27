import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { memoryRateLimit, rateLimit, rateLimitBackend, rateLimitHeaders } from "./ratelimit";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

function withEnv(values: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

describe("memory rate limit", () => {
  test("allows `limit` calls a minute per key, then refuses", () => {
    const key = `test:${Math.random()}`;
    const results = Array.from({ length: 4 }, () => memoryRateLimit(key, 3).ok);
    assert.deepEqual(results, [true, true, true, false]);
    assert.equal(memoryRateLimit(`${key}:other`, 3).ok, true, "keys are independent");
  });

  test("counts down remaining and says when the oldest call leaves the window", (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 2_000_000 });
    const key = `test:${Math.random()}`;
    assert.deepEqual(memoryRateLimit(key, 2), { ok: true, limit: 2, remaining: 1, resetSeconds: 60 });
    t.mock.timers.tick(15_000);
    assert.equal(memoryRateLimit(key, 2).remaining, 0);
    assert.deepEqual(memoryRateLimit(key, 2), { ok: false, limit: 2, remaining: 0, resetSeconds: 45, retryAfterSeconds: 45 });
    t.mock.timers.tick(45_001);
    assert.equal(memoryRateLimit(key, 2).ok, true);
  });

  test("a flood of new keys does not reset a caller who is over the limit", () => {
    const key = `victim:${Math.random()}`;
    memoryRateLimit(key, 1);
    assert.equal(memoryRateLimit(key, 1).ok, false);
    for (let i = 0; i < 10_050; i += 1) memoryRateLimit(`flood:${i}:${Math.random()}`, 1);
    assert.equal(memoryRateLimit(key, 1).ok, false);
  });
});

describe("rateLimitHeaders", () => {
  test("sets RateLimit-* always and Retry-After only when refused", () => {
    const ok = rateLimitHeaders({ ok: true, limit: 6, remaining: 5, resetSeconds: 60 });
    assert.deepEqual(ok, { "RateLimit-Limit": "6", "RateLimit-Remaining": "5", "RateLimit-Reset": "60", "RateLimit-Policy": "6;w=60" });
    const refused = rateLimitHeaders({ ok: false, limit: 6, remaining: 0, resetSeconds: 9, retryAfterSeconds: 9 });
    assert.equal(refused["Retry-After"], "9");
  });
});

describe("Upstash backend", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("is chosen when both KV variables are set, and sends one atomic transaction", async () => {
    const restore = withEnv({ KV_REST_API_URL: "https://kv.example/", KV_REST_API_TOKEN: "kv-token", DATABASE_URL: undefined });
    const calls: { url: string; auth: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify([{ result: 7 }, { result: 1 }, { result: null }]));
    }) as typeof fetch;
    try {
      assert.equal(rateLimitBackend(), "upstash");
      const result = await rateLimit("publish:ui:ip:1", 6);
      assert.equal(result.ok, false);
      assert.equal(result.remaining, 0);
      assert.ok(result.retryAfterSeconds! >= 1 && result.retryAfterSeconds! <= 60);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.url, "https://kv.example/multi-exec");
      assert.equal(calls[0]?.auth, "Bearer kv-token");
      const [incr, expire, get] = calls[0]?.body as string[][];
      assert.equal(incr?.[0], "INCR");
      assert.equal(expire?.[0], "PEXPIRE");
      assert.equal(get?.[0], "GET");
    } finally {
      restore();
    }
  });

  test("falls back to memory when Upstash is down, and never echoes the token", async (t) => {
    const restore = withEnv({ KV_REST_API_URL: "https://kv.example", KV_REST_API_TOKEN: "kv-secret-token" });
    globalThis.fetch = (async () => new Response("nope", { status: 503 })) as typeof fetch;
    const logged: string[] = [];
    t.mock.method(console, "error", (line: string) => logged.push(line));
    try {
      const key = `down:${Math.random()}`;
      assert.equal((await rateLimit(key, 1)).ok, true);
      assert.equal((await rateLimit(key, 1)).ok, false, "still limited by this instance");
      assert.match(logged.join("\n"), /rate_limit_store_failed/);
      assert.doesNotMatch(logged.join("\n"), /kv-secret-token/);
    } finally {
      restore();
    }
  });
});

describe("Postgres backend", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("counts in the database, so every instance shares the limit", async () => {
    assert.equal(rateLimitBackend(), "postgres");
    const key = `shared:${Math.random()}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push((await rateLimit(key, 3)).ok);
    assert.deepEqual(results.slice(0, 3), [true, true, true]);
    assert.equal(results[3], false);
    const [row] = await query<{ total: number }>("SELECT sum(count)::int AS total FROM rate_limits WHERE key = $1", [key]);
    assert.equal(row?.total, 4);
  });

  test("concurrent calls are counted atomically", async () => {
    const key = `burst:${Math.random()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => rateLimit(key, 10)));
    // A window boundary mid-burst can only refuse more, never allow more.
    assert.ok(results.filter((result) => result.ok).length <= 10);
    const [row] = await query<{ total: number }>("SELECT sum(count)::int AS total FROM rate_limits WHERE key = $1", [key]);
    assert.equal(row?.total, 20);
  });
});
