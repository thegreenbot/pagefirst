import { NextResponse } from "next/server";
import { billingStatus } from "@/lib/billing/billing";
import { stripeConfigured } from "@/lib/billing/stripe";
import { databaseConfigured } from "@/lib/db/client";
import { requireGoogleWriter } from "@/lib/guard";
import { getOrganization, roleOf } from "@/lib/tenant/orgs";

export const dynamic = "force-dynamic";

/** An organization's plan and subscription state, for members. `?orgId=...` */
export async function GET(request: Request) {
  const writer = await requireGoogleWriter();
  if (!writer.ok || !writer.sub) return NextResponse.json({ error: "Sign in with Google to see billing." }, { status: 401 });
  if (!databaseConfigured()) return NextResponse.json({ error: "Billing needs the database." }, { status: 503 });
  const orgId = new URL(request.url).searchParams.get("orgId") ?? "";
  if (!(await roleOf(orgId, writer.sub))) return NextResponse.json({ error: "Organization not found." }, { status: 404 });
  const org = await getOrganization(orgId);
  if (!org) return NextResponse.json({ error: "Organization not found." }, { status: 404 });
  return NextResponse.json({ billingEnabled: stripeConfigured(), ...(await billingStatus(org.id, org.plan)) });
}
