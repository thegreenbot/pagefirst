import { databaseConfigured, query } from "@/lib/db/client";
import { redact } from "@/lib/log";

/**
 * Rate limits shared across instances (#18). Upstash Redis when
 * KV_REST_API_URL and KV_REST_API_TOKEN are set, else Postgres when
 * DATABASE_URL is set, else this process's memory (local dev and tests).
 *
 * The shared stores use a sliding-window counter: this window's count plus the
 * previous window's count weighted by how much of it still overlaps. Every
 * call counts, refused ones included, so a flood stays refused.
 */

export const WINDOW_MS = 60_000;

export type RateLimitVerdict = {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the window frees a slot. */
  resetSeconds: number;
  /** Set when refused: same as resetSeconds, for Retry-After. */
  retryAfterSeconds?: number;
};

type Backend = "upstash" | "postgres" | "memory";

export function rateLimitBackend(): Backend {
  if (process.env.KV_REST_API_URL?.trim() && process.env.KV_REST_API_TOKEN?.trim()) return "upstash";
  if (databaseConfigured()) return "postgres";
  return "memory";
}

function verdict(limit: number, used: number, resetSeconds: number): RateLimitVerdict {
  const ok = used <= limit;
  const reset = Math.max(1, resetSeconds);
  return {
    ok,
    limit,
    remaining: Math.max(0, Math.floor(limit - used)),
    resetSeconds: reset,
    ...(ok ? {} : { retryAfterSeconds: reset }),
  };
}

/** Sliding-window estimate from two fixed windows. */
function estimate(current: number, previous: number, now: number): number {
  const elapsed = (now % WINDOW_MS) / WINDOW_MS;
  return previous * (1 - elapsed) + current;
}

function secondsToWindowEnd(now: number): number {
  return Math.ceil((WINDOW_MS - (now % WINDOW_MS)) / 1000);
}

// ---- memory: an exact sliding log per key ----

const MAX_MEMORY_KEYS = 10_000;
const holder = globalThis as typeof globalThis & { __pageFirstRateBuckets?: Map<string, number[]> };
const buckets: Map<string, number[]> = holder.__pageFirstRateBuckets ?? new Map();
holder.__pageFirstRateBuckets = buckets;

/** Drops only keys with no call left in the window, so a flood of new keys can't reset anyone's limit. */
function sweepMemory(now: number): void {
  for (const [key, stamps] of buckets) {
    if (!stamps.some((stamp) => now - stamp < WINDOW_MS)) buckets.delete(key);
  }
}

export function memoryRateLimit(key: string, limit: number): RateLimitVerdict {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    const oldest = recent[0] ?? now;
    return verdict(limit, limit + 1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > MAX_MEMORY_KEYS) sweepMemory(now);
  const oldest = recent[0] ?? now;
  return verdict(limit, recent.length, Math.ceil((oldest + WINDOW_MS - now) / 1000));
}

// ---- Postgres ----

async function postgresRateLimit(key: string, limit: number): Promise<RateLimitVerdict> {
  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS);
  const [row] = await query<{ current: number; previous: number }>(
    `WITH bumped AS (
       INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
       RETURNING count
     )
     SELECT (SELECT count FROM bumped) AS current,
            coalesce((SELECT count FROM rate_limits WHERE key = $1 AND window_start = $2 - 1), 0) AS previous`,
    [key, window],
  );
  // Old windows are only ever read one back; clear older ones now and then.
  if (Math.random() < 0.01) {
    void query("DELETE FROM rate_limits WHERE window_start < $1", [window - 1]).catch(() => undefined);
  }
  return verdict(limit, estimate(Number(row?.current ?? 1), Number(row?.previous ?? 0), now), secondsToWindowEnd(now));
}

// ---- Upstash Redis (REST) ----

async function upstashRateLimit(key: string, limit: number): Promise<RateLimitVerdict> {
  const now = Date.now();
  const window = Math.floor(now / WINDOW_MS);
  const current = `rl:${key}:${window}`;
  const previous = `rl:${key}:${window - 1}`;
  const url = process.env.KV_REST_API_URL!.trim().replace(/\/+$/, "");
  const response = await fetch(`${url}/multi-exec`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN!.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify([
      ["INCR", current],
      ["PEXPIRE", current, String(WINDOW_MS * 2)],
      ["GET", previous],
    ]),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`Upstash answered ${response.status}`);
  const results = (await response.json()) as { result?: unknown; error?: string }[];
  const failed = results.find((entry) => entry.error);
  if (failed) throw new Error(`Upstash error: ${failed.error}`);
  return verdict(limit, estimate(Number(results[0]?.result ?? 1), Number(results[2]?.result ?? 0), now), secondsToWindowEnd(now));
}

/**
 * Counts one call for `key` and says whether it is within `limit` a minute.
 * If the shared store fails, the call is limited by this instance's memory
 * instead, so an outage neither blocks everyone nor removes the limit.
 */
export async function rateLimit(key: string, limit: number): Promise<RateLimitVerdict> {
  const backend = rateLimitBackend();
  if (backend === "memory") return memoryRateLimit(key, limit);
  try {
    return backend === "upstash" ? await upstashRateLimit(key, limit) : await postgresRateLimit(key, limit);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", type: "rate_limit_store_failed", backend, error: redact(String(error)) }));
    return memoryRateLimit(key, limit);
  }
}

/** The IETF draft RateLimit-* headers plus Retry-After when refused. */
export function rateLimitHeaders(result: RateLimitVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetSeconds),
    "RateLimit-Policy": `${result.limit};w=${WINDOW_MS / 1000}`,
  };
  if (!result.ok) headers["Retry-After"] = String(result.retryAfterSeconds ?? result.resetSeconds);
  return headers;
}
