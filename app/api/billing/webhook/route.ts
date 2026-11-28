import { NextResponse } from "next/server";
import { recordAudit, requestIdFrom } from "@/lib/audit";
import { handleEvent } from "@/lib/billing/billing";
import { stripeConfigured, verifyWebhook } from "@/lib/billing/stripe";
import { databaseConfigured } from "@/lib/db/client";
import { readTextCapped } from "@/lib/http/body";

export const dynamic = "force-dynamic";

/**
 * Stripe's webhook. Authenticated by the signature over the raw body, not a
 * cookie. Any failure inside handling returns 500 so Stripe retries.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret || !stripeConfigured() || !databaseConfigured()) return NextResponse.json({ error: "Billing is not enabled." }, { status: 404 });
  const read = await readTextCapped(request, 512_000);
  if (!read.ok) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  const event = verifyWebhook(read.text, request.headers.get("stripe-signature"), secret);
  if (!event) return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  const result = await handleEvent(event);
  if (result === "handled") {
    await recordAudit({ event: "billing.subscription", outcome: "ok", requestId: requestIdFrom(request), actorSub: null, status: 200 });
  }
  return NextResponse.json({ received: true, result });
}
