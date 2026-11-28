import { createHash } from "node:crypto";
import { rateLimit, type RateLimitVerdict } from "@/lib/ratelimit";
import { ServiceError, type GoogleClient, type ServiceContext } from "./context";
import { upstreamStatus } from "./google";

/**
 * A per-user budget in front of every Google call, plus backoff with jitter
 * when Google still answers 429 (#39).
 *
 * Google's Docs API allows 60 write requests a minute per user and 600 per
 * project, and reads at 300 and 3000. We stay under the per-user figure so a
 * bulk caller's writes are delayed, not refused: a call waits for a free slot,
 * up to `maxWaitMs`. Past that the caller gets a typed `upstream_quota` error
 * with Retry-After and nothing has been sent to Google.
 *
 * Only 429 is retried for writes. A 5xx on a write may have been applied, and
 * repeating it is the caller's decision (commits carry a baseRevisionId, and
 * #38 adds idempotency keys). Reads retry 429 and 5xx.
 */

export type QuotaConfig = {
  writesPerMinute: number;
  readsPerMinute: number;
  /** Longest a single call waits for a slot before giving up. */
  maxWaitMs: number;
  /** Retries after a Google 429 (and 5xx for reads). */
  retries: number;
  baseBackoffMs: number;
  limit: (key: string, perMinute: number) => Promise<RateLimitVerdict>;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const DEFAULT_QUOTA: QuotaConfig = {
  writesPerMinute: 50,
  readsPerMinute: 250,
  maxWaitMs: 20_000,
  retries: 3,
  baseBackoffMs: 500,
  limit: rateLimit,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Who Google counts the call against: the account, or a hash of the token when the sub is unknown. */
export function quotaSubject(ctx: ServiceContext): string {
  if (ctx.actor.sub) return createHash("sha256").update(ctx.actor.sub).digest("hex").slice(0, 24);
  return createHash("sha256").update(ctx.googleToken ?? "none").digest("hex").slice(0, 24);
}

async function acquire(kind: "read" | "write", subject: string, config: QuotaConfig): Promise<void> {
  const perMinute = kind === "write" ? config.writesPerMinute : config.readsPerMinute;
  let waited = 0;
  for (;;) {
    const verdict = await config.limit(`google:${kind}:${subject}`, perMinute);
    if (verdict.ok) return;
    const waitMs = (verdict.retryAfterSeconds ?? verdict.resetSeconds) * 1000;
    if (waited + waitMs > config.maxWaitMs) {
      throw new ServiceError("upstream_quota", "Google's per-user limit for this account is used up. Retry after the delay.", {
        retryAfterSeconds: verdict.retryAfterSeconds ?? verdict.resetSeconds,
      });
    }
    await config.sleep(waitMs);
    waited += waitMs;
  }
}

/** Exponential backoff with full jitter: a random wait in [0, base * 2^attempt]. */
export function backoffMs(attempt: number, base: number, random: () => number): number {
  return Math.round(random() * base * 2 ** attempt);
}

async function guarded<T>(kind: "read" | "write", subject: string, config: QuotaConfig, call: () => Promise<T>): Promise<T> {
  await acquire(kind, subject, config);
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const status = upstreamStatus(err);
      const retryable = status === 429 || (kind === "read" && status !== null && status >= 500);
      if (!retryable || attempt >= config.retries) throw err;
      await config.sleep(backoffMs(attempt + 1, config.baseBackoffMs, config.random));
      // A retry is another request to Google, so it takes a slot too.
      await acquire(kind, subject, config);
    }
  }
}

export function withGoogleQuota(google: GoogleClient, subject: string, overrides: Partial<QuotaConfig> = {}): GoogleClient {
  const config = { ...DEFAULT_QUOTA, ...overrides };
  const read = <T>(call: () => Promise<T>) => guarded("read", subject, config, call);
  const write = <T>(call: () => Promise<T>) => guarded("write", subject, config, call);
  return {
    listDocuments: (token, folderIds) => read(() => google.listDocuments(token, folderIds)),
    fetchDocument: (token, fileId) => read(() => google.fetchDocument(token, fileId)),
    createDocument: (token, title) => write(() => google.createDocument(token, title)),
    batchUpdate: (token, fileId, requests) => write(() => google.batchUpdate(token, fileId, requests)),
    ...(google.driveMeta ? { driveMeta: (token: string, fileId: string) => read(() => google.driveMeta!(token, fileId)) } : {}),
    ...(google.parentsOf ? { parentsOf: (token: string, fileId: string) => read(() => google.parentsOf!(token, fileId)) } : {}),
  };
}
