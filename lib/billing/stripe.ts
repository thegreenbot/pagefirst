import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A small Stripe client over fetch (#47): enough for Checkout, the customer
 * portal and subscription quantity, with no SDK dependency. Webhook bodies are
 * authenticated by their signature, never by a cookie.
 */

const API = "https://api.stripe.com/v1";

export class StripeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "StripeError";
  }
}

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

/** Stripe's form encoding for nested params: a[b]=1, items[0][price]=x. */
export function encodeForm(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        parts.push(typeof item === "object" && item !== null ? encodeForm(item as Record<string, unknown>, `${name}[${i}]`) : `${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof value === "object") {
      parts.push(encodeForm(value as Record<string, unknown>, name));
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join("&");
}

export async function stripeRequest<T>(method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new StripeError("Billing is not configured.", 503);
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const body = method === "POST" ? encodeForm(params) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  const query = method === "GET" && Object.keys(params).length ? `?${encodeForm(params)}` : "";
  const res = await fetch(`${API}${path}${query}`, { method, headers, body, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
  if (!res.ok) throw new StripeError(json.error?.message ?? `Stripe request failed (${res.status})`, res.status);
  return json;
}

export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

const TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header over the raw body and returns the event.
 * Returns null for a missing, malformed, stale or wrong signature.
 */
export function verifyWebhook(rawBody: string, header: string | null, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): StripeEvent | null {
  if (!header) return null;
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") timestamp = v ?? "";
    else if (k === "v1" && v) signatures.push(v);
  }
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) return null;
  if (Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) return null;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  const ok = signatures.some((sig) => {
    if (!/^[0-9a-f]{64}$/.test(sig)) return false;
    return timingSafeEqual(Buffer.from(sig, "hex"), expected);
  });
  if (!ok) return null;
  try {
    const event = JSON.parse(rawBody) as StripeEvent;
    return typeof event.id === "string" && typeof event.type === "string" && event.data?.object ? event : null;
  } catch {
    return null;
  }
}

/** Builds a valid signature header, for tests. */
export function signWebhook(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},v1=${sig}`;
}
