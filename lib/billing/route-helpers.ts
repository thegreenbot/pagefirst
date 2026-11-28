import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { databaseConfigured } from "@/lib/db/client";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { readTextCapped } from "@/lib/http/body";
import { BillingError } from "./billing";
import { stripeConfigured, StripeError } from "./stripe";

export type Caller = { sub: string; body: Record<string, unknown> };

/** Shared checks for the cookie-authenticated billing routes: sign-in, configuration, rate limit, JSON body. */
export async function billingCaller(request: Request, action: string): Promise<Caller | NextResponse> {
  const writer = await requireGoogleWriter();
  if (!writer.ok || !writer.sub) return NextResponse.json({ error: "Sign in with Google to manage billing." }, { status: 401 });
  if (!stripeConfigured() || !databaseConfigured()) return NextResponse.json({ error: "Billing is not enabled on this instance." }, { status: 404 });
  const limit = await checkRateLimit(action, callerKey(writer.token, request, writer.sub), 10);
  if (!limit.ok) return tooManyRequests("Too many billing requests.", limit);
  const read = await readTextCapped(request, 2_000);
  if (!read.ok) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  try {
    const body = read.text ? JSON.parse(read.text) : {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return { sub: writer.sub, body: body as Record<string, unknown> };
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
}

export async function billingResult(request: Request, event: "billing.checkout" | "billing.portal", orgId: string, work: () => Promise<{ url: string }>): Promise<NextResponse> {
  try {
    const result = await work();
    await auditRequest(request, { event, outcome: "ok", status: 200, siteId: null, pagePath: orgId });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof BillingError) {
      await auditRequest(request, { event, outcome: "denied", status: error.status, pagePath: orgId });
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof StripeError) {
      console.error("stripe request failed", error.status);
      await auditRequest(request, { event, outcome: "error", status: 502, pagePath: orgId });
      return NextResponse.json({ error: "The payment provider could not complete the request." }, { status: 502 });
    }
    throw error;
  }
}
