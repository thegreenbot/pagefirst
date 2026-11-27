import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { googleConfigured } from "@/lib/google/config";
import { rateLimit, rateLimitHeaders, type RateLimitVerdict } from "@/lib/ratelimit";
import { getAccessToken, getSessionSub } from "@/lib/session";

export { sameOrigin } from "@/lib/http/csrf";
export type { RateLimitVerdict } from "@/lib/ratelimit";

export async function requireGoogleWriter(): Promise<
  { ok: true; token: string | null; sub: string | null } | { ok: false; error: string }
> {
  const token = await getAccessToken();
  if (googleConfigured() && !token) {
    return { ok: false, error: "Sign in with Google to do this." };
  }
  return { ok: true, token, sub: token ? await getSessionSub() : null };
}

/**
 * Who a rate limit counts against: the Google account when there is a server
 * session, else a hash of the legacy token, else the client IP.
 */
export function callerKey(token: string | null, request: Request, sub: string | null = null): string {
  if (sub) return `sub:${createHash("sha256").update(sub).digest("hex").slice(0, 24)}`;
  if (token) return createHash("sha256").update(token).digest("hex").slice(0, 24);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = forwarded.slice(0, 64) || "local";
  return `ip:${ip}`;
}

export type Client = "ui" | "api" | "mcp";

/**
 * Counts one call against `limit` a minute. Budgets are separate per action
 * and per client type, so API or MCP traffic can't use up the editor's.
 */
export function checkRateLimit(action: string, caller: string, limit: number, client: Client = "ui"): Promise<RateLimitVerdict> {
  return rateLimit(`${action}:${client}:${caller}`, limit);
}

/** A 429 that tells the client when to retry, with RateLimit-* headers. */
export function tooManyRequests(message: string, result: RateLimitVerdict): NextResponse<{ error: string }> {
  return NextResponse.json({ error: message }, { status: 429, headers: rateLimitHeaders(result) });
}

/** Adds RateLimit-* headers to a successful response. */
export function withRateLimit<T>(response: NextResponse<T>, result: RateLimitVerdict): NextResponse<T> {
  for (const [name, value] of Object.entries(rateLimitHeaders(result))) response.headers.set(name, value);
  return response;
}
