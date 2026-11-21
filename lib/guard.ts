import { createHash } from "node:crypto";
import { googleConfigured } from "@/lib/google/config";
import { getAccessToken } from "@/lib/session";

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

export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export function callerKey(token: string | null, request: Request): string {
  if (token) return createHash("sha256").update(token).digest("hex").slice(0, 24);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = forwarded.slice(0, 64) || "local";
  return `ip:${ip}`;
}

/** Returns false when this caller has already hit `limit` calls in the last minute. */
export function withinRateLimit(key: string, limit: number): boolean {
  const now = Date.now();
  const recent = (buckets.get(key) ?? []).filter((stamp) => now - stamp < WINDOW_MS);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 500) {
    const oldest = buckets.keys().next().value;
    if (oldest) buckets.delete(oldest);
  }
  return true;
}
