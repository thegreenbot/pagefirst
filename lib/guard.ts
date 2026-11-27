import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { googleConfigured } from "@/lib/google/config";
import { getAccessToken } from "@/lib/session";

export { sameOrigin } from "@/lib/http/csrf";

const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();

export async function requireGoogleWriter(): Promise<
  { ok: true; token: string | null } | { ok: false; error: string }
> {
  const token = await getAccessToken();
  if (googleConfigured() && !token) {
    return { ok: false, error: "Sign in with Google to do this." };
  }
  return { ok: true, token };
}

export function callerKey(token: string | null, request: Request): string {
  if (token) return createHash("sha256").update(token).digest("hex").slice(0, 24);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = forwarded.slice(0, 64) || "local";
  return `ip:${ip}`;
}

export type RateLimitVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Allows `limit` calls per key in any rolling minute. When refused, says how long until a slot frees. */
export function checkRateLimit(key: string, limit: number): RateLimitVerdict {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    const oldest = recent[0] ?? now;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000)) };
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 500) {
    const oldest = buckets.keys().next().value;
    if (oldest) buckets.delete(oldest);
  }
  return { ok: true };
}

/** Returns false when this caller has already hit `limit` calls in the last minute. */
export function withinRateLimit(key: string, limit: number): boolean {
  return checkRateLimit(key, limit).ok;
}

/** A 429 that tells the client when to retry. */
export function tooManyRequests(message: string, retryAfterSeconds: number): NextResponse<{ error: string }> {
  return NextResponse.json(
    { error: message },
    { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
  );
}
