import { NextResponse } from "next/server";
import { startPortal } from "@/lib/billing/billing";
import { billingCaller, billingResult } from "@/lib/billing/route-helpers";

export const dynamic = "force-dynamic";

/** Opens the Stripe customer portal (payment method, invoices, plan changes, cancel). Owners and admins only. */
export async function POST(request: Request) {
  const caller = await billingCaller(request, "billing-portal");
  if (caller instanceof NextResponse) return caller;
  const { orgId } = caller.body;
  if (typeof orgId !== "string") return NextResponse.json({ error: "orgId is required." }, { status: 400 });
  return billingResult(request, "billing.portal", orgId, () => startPortal({ orgId, sub: caller.sub }));
}
