import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { backoffMs, quotaSubject, withGoogleQuota, type QuotaConfig } from "./quota";
import { ServiceError, type GoogleClient } from "./context";
import type { RateLimitVerdict } from "@/lib/ratelimit";

/** A fixed-window limiter on a virtual clock that only counts calls it lets through. */
function virtualClock(window = 60_000) {
  let now = 0;
  const counts = new Map<number, number>();
  return {
    now: () => now,
    /** Calls the limiter let through, per window: what Google is sent. */
    granted: () => [...counts.values()],
    sleep: async (ms: number) => { now += ms; },
    limit: async (_key: string, perMinute: number): Promise<RateLimitVerdict> => {
      const w = Math.floor(now / window);
      const used = counts.get(w) ?? 0;
      const reset = Math.ceil(((w + 1) * window - now) / 1000);
      if (used >= perMinute) return { ok: false, limit: perMinute, remaining: 0, resetSeconds: reset, retryAfterSeconds: reset };
      counts.set(w, used + 1);
      return { ok: true, limit: perMinute, remaining: perMinute - used - 1, resetSeconds: reset };
    },
  };
}

function fake(overrides: Partial<GoogleClient> = {}): GoogleClient {
  return {
    listDocuments: async () => [],
    fetchDocument: async () => ({}) as never,
    createDocument: async () => ({}) as never,
    batchUpdate: async () => undefined,
    ...overrides,
  };
}

const config = (clock: ReturnType<typeof virtualClock>, extra: Partial<QuotaConfig> = {}): Partial<QuotaConfig> => ({
  limit: clock.limit, sleep: clock.sleep, random: () => 0.5, ...extra,
});

describe("Google quota", () => {
  test("500 commits from one account stay inside 60 writes a minute, delayed and none failed", async () => {
    const clock = virtualClock();
    let sent = 0;
    const google = withGoogleQuota(fake({ batchUpdate: async () => { sent++; } }), "u1", config(clock, { maxWaitMs: 60 * 60_000 }));
    const results = await Promise.allSettled(Array.from({ length: 500 }, () => google.batchUpdate("t", "doc", [])));
    assert.equal(results.filter((r) => r.status === "rejected").length, 0);
    assert.equal(sent, 500);
    assert.ok(Math.max(...clock.granted()) <= 60, `peak ${Math.max(...clock.granted())}`);
  });

  test("when the wait would be too long it fails with Retry-After and never calls Google", async () => {
    const clock = virtualClock();
    let calls = 0;
    const google = withGoogleQuota(fake({ batchUpdate: async () => { calls++; } }), "u1", config(clock, { writesPerMinute: 2, maxWaitMs: 1_000 }));
    await google.batchUpdate("t", "d", []);
    await google.batchUpdate("t", "d", []);
    await assert.rejects(google.batchUpdate("t", "d", []), (err: unknown) => err instanceof ServiceError && err.code === "upstream_quota" && (err.retryAfterSeconds ?? 0) > 0);
    assert.equal(calls, 2);
  });

  test("a Google 429 is retried with backoff and then succeeds", async () => {
    const clock = virtualClock();
    let calls = 0;
    const google = withGoogleQuota(fake({ batchUpdate: async () => { if (++calls < 3) throw new Error("Docs write failed (429)"); } }), "u1", config(clock));
    await google.batchUpdate("t", "d", []);
    assert.equal(calls, 3);
    assert.ok(clock.now() > 0);
  });

  test("a 5xx on a write is not repeated, on a read it is", async () => {
    const clock = virtualClock();
    let writes = 0;
    let reads = 0;
    const google = withGoogleQuota(
      fake({
        batchUpdate: async () => { writes++; throw new Error("Docs write failed (503)"); },
        fetchDocument: async () => { if (++reads < 2) throw new Error("Docs read failed (503)"); return {} as never; },
      }),
      "u1",
      config(clock),
    );
    await assert.rejects(google.batchUpdate("t", "d", []), /503/);
    assert.equal(writes, 1);
    await google.fetchDocument("t", "d");
    assert.equal(reads, 2);
  });

  test("persistent 429s give up after the retries", async () => {
    const clock = virtualClock();
    let calls = 0;
    const google = withGoogleQuota(fake({ batchUpdate: async () => { calls++; throw new Error("Docs write failed (429)"); } }), "u1", config(clock, { retries: 2 }));
    await assert.rejects(google.batchUpdate("t", "d", []), /429/);
    assert.equal(calls, 3);
  });

  test("backoff grows and is jittered; the subject never contains the token", () => {
    assert.equal(backoffMs(1, 500, () => 1), 1000);
    assert.equal(backoffMs(3, 500, () => 1), 4000);
    assert.equal(backoffMs(2, 500, () => 0), 0);
    const subject = quotaSubject({ actor: { sub: null, client: "api" }, googleToken: "tok-secret", requestId: "r" });
    assert.doesNotMatch(subject, /tok-secret/);
  });
});
