import { NextResponse } from "next/server";
import { isInterval, isPaidPlan, startCheckout } from "@/lib/billing/billing";
import { billingCaller, billingResult } from "@/lib/billing/route-helpers";

export const dynamic = "force-dynamic";

/** Starts a Stripe Checkout for an organization's subscription. Owners and admins only. */
export async function POST(request: Request) {
  const caller = await billingCaller(request, "billing-checkout");
  if (caller instanceof NextResponse) return caller;
  const { orgId, plan, interval } = caller.body;
  if (typeof orgId !== "string" || !isPaidPlan(plan) || !isInterval(interval)) {
    return NextResponse.json({ error: "orgId, plan (pro or team) and interval (month or year) are required." }, { status: 400 });
  }
  return billingResult(request, "billing.checkout", orgId, () => startCheckout({ orgId, sub: caller.sub, plan, interval }));
}
