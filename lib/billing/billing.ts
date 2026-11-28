import { query } from "@/lib/db/client";
import { roleOf, seatCount, setPlan } from "@/lib/tenant/orgs";
import type { Plan } from "@/lib/tenant/plans";
import { stripeRequest, StripeError, type StripeEvent } from "./stripe";

/**
 * Billing (#47): Stripe subscriptions per organization, priced per seat
 * (editors and above; viewers are free). Stripe is the source of truth: every
 * subscription event re-reads the subscription from Stripe, so a late or
 * out-of-order webhook cannot overwrite newer state. The plan on the
 * organization changes only through `setPlan`.
 */

export type PaidPlan = "pro" | "team";
export type Interval = "month" | "year";

/** Team needs at least this many paid seats. */
export const MIN_SEATS: Record<PaidPlan, number> = { pro: 1, team: 3 };

const PRICE_ENV: Record<PaidPlan, Record<Interval, string>> = {
  pro: { month: "STRIPE_PRICE_PRO_MONTH", year: "STRIPE_PRICE_PRO_YEAR" },
  team: { month: "STRIPE_PRICE_TEAM_MONTH", year: "STRIPE_PRICE_TEAM_YEAR" },
};

export function priceFor(plan: PaidPlan, interval: Interval): string | null {
  return process.env[PRICE_ENV[plan][interval]]?.trim() || null;
}

export function planForPrice(priceId: string): { plan: PaidPlan; interval: Interval } | null {
  for (const plan of ["pro", "team"] as const) {
    for (const interval of ["month", "year"] as const) {
      if (priceFor(plan, interval) === priceId) return { plan, interval };
    }
  }
  return null;
}

export const isPaidPlan = (v: unknown): v is PaidPlan => v === "pro" || v === "team";
export const isInterval = (v: unknown): v is Interval => v === "month" || v === "year";

export class BillingError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BillingError";
  }
}

/** The Stripe calls billing makes, replaceable in tests. */
export type StripeApi = <T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string) => Promise<T>;

type BillingRow = {
  org_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string | null;
  status: string | null;
  plan: PaidPlan | null;
  billing_interval: Interval | null;
  seats: number | null;
  current_period_end: Date | null;
};

async function billingRow(orgId: string): Promise<BillingRow | null> {
  const rows = await query<BillingRow>("SELECT * FROM org_billing WHERE org_id = $1", [orgId]);
  return rows[0] ?? null;
}

export type BillingStatus = {
  plan: Plan;
  status: string | null;
  interval: Interval | null;
  seats: number | null;
  currentPeriodEnd: string | null;
  hasCustomer: boolean;
};

export async function billingStatus(orgId: string, currentPlan: Plan): Promise<BillingStatus> {
  const row = await billingRow(orgId);
  return {
    plan: currentPlan,
    status: row?.status ?? null,
    interval: row?.billing_interval ?? null,
    seats: row?.seats ?? null,
    currentPeriodEnd: row?.current_period_end?.toISOString() ?? null,
    hasCustomer: Boolean(row),
  };
}

async function requireBillingRole(orgId: string, sub: string): Promise<void> {
  const role = await roleOf(orgId, sub);
  if (role !== "owner" && role !== "admin") throw new BillingError("Only an owner or admin can manage billing.", 403);
}

async function customerFor(orgId: string, sub: string, api: StripeApi): Promise<string> {
  const existing = await billingRow(orgId);
  if (existing) return existing.stripe_customer_id;
  const customer = await api<{ id: string }>("POST", "/customers", { metadata: { org_id: orgId, created_by: sub } }, `pf-customer-${orgId}`);
  const rows = await query<{ stripe_customer_id: string }>(
    `INSERT INTO org_billing (org_id, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET updated_at = now() RETURNING stripe_customer_id`,
    [orgId, customer.id],
  );
  return rows[0]!.stripe_customer_id;
}

function appUrl(): string {
  const url = process.env.APP_URL?.trim().replace(/\/$/, "");
  if (!url) throw new BillingError("APP_URL is not set.", 503);
  return url;
}

/** A Stripe Checkout URL for a new subscription. Refuses an organization that already has one. */
export async function startCheckout(
  input: { orgId: string; sub: string; plan: PaidPlan; interval: Interval },
  api: StripeApi = stripeRequest,
): Promise<{ url: string }> {
  await requireBillingRole(input.orgId, input.sub);
  const price = priceFor(input.plan, input.interval);
  if (!price) throw new BillingError("That plan is not available.", 400);
  const existing = await billingRow(input.orgId);
  if (existing?.stripe_subscription_id && ["active", "trialing", "past_due"].includes(existing.status ?? "")) {
    throw new BillingError("This organization already has a subscription. Use the billing portal to change it.", 409);
  }
  const customer = await customerFor(input.orgId, input.sub, api);
  const quantity = Math.max(await seatCount(input.orgId), MIN_SEATS[input.plan]);
  const session = await api<{ url?: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: input.orgId,
    line_items: [{ price, quantity }],
    subscription_data: { metadata: { org_id: input.orgId } },
    allow_promotion_codes: true,
    success_url: `${appUrl()}/?billing=success`,
    cancel_url: `${appUrl()}/?billing=cancelled`,
  });
  if (!session.url) throw new BillingError("Stripe did not return a checkout URL.", 502);
  return { url: session.url };
}

/** A Stripe customer portal URL, for payment methods, invoices, plan changes and cancellation. */
export async function startPortal(input: { orgId: string; sub: string }, api: StripeApi = stripeRequest): Promise<{ url: string }> {
  await requireBillingRole(input.orgId, input.sub);
  const row = await billingRow(input.orgId);
  if (!row) throw new BillingError("This organization has no billing account yet.", 404);
  const session = await api<{ url?: string }>("POST", "/billing_portal/sessions", { customer: row.stripe_customer_id, return_url: `${appUrl()}/` });
  if (!session.url) throw new BillingError("Stripe did not return a portal URL.", 502);
  return { url: session.url };
}

type StripeSubscription = {
  id: string;
  customer: string;
  status: string;
  metadata?: Record<string, string>;
  current_period_end?: number;
  items?: { data?: { id: string; quantity?: number; current_period_end?: number; price?: { id?: string } }[] };
};

/** Statuses that keep a paid plan. Everything else, including a lapsed payment, returns to free. */
const ENTITLED = new Set(["active", "trialing", "past_due"]);

async function orgForSubscription(sub: StripeSubscription): Promise<string | null> {
  if (sub.metadata?.org_id) return sub.metadata.org_id;
  const rows = await query<{ org_id: string }>("SELECT org_id FROM org_billing WHERE stripe_customer_id = $1", [sub.customer]);
  return rows[0]?.org_id ?? null;
}

/** Writes a subscription's state to the organization. Returns the plan it ended on. */
export async function applySubscription(sub: StripeSubscription): Promise<Plan | null> {
  const orgId = await orgForSubscription(sub);
  if (!orgId) return null;
  const item = sub.items?.data?.[0];
  const mapped = item?.price?.id ? planForPrice(item.price.id) : null;
  const entitled = ENTITLED.has(sub.status) && mapped !== null;
  const periodEnd = sub.current_period_end ?? item?.current_period_end;
  await query(
    `INSERT INTO org_billing (org_id, stripe_customer_id, stripe_subscription_id, status, plan, billing_interval, seats, current_period_end, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       status = EXCLUDED.status, plan = EXCLUDED.plan, billing_interval = EXCLUDED.billing_interval, seats = EXCLUDED.seats,
       current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
    [orgId, sub.customer, sub.id, sub.status, mapped?.plan ?? null, mapped?.interval ?? null, item?.quantity ?? null, periodEnd ? new Date(periodEnd * 1000) : null],
  );
  const plan: Plan = entitled ? mapped!.plan : "free";
  await setPlan(orgId, plan);
  return plan;
}

export type HandleResult = "handled" | "duplicate" | "ignored";

/**
 * Applies one verified webhook event. Each event id is processed once; the
 * subscription is re-read from Stripe so ordering of deliveries doesn't matter.
 */
export async function handleEvent(event: StripeEvent, api: StripeApi = stripeRequest): Promise<HandleResult> {
  const seen = await query<{ id: string }>("SELECT id FROM stripe_events WHERE id = $1", [event.id]);
  if (seen.length) return "duplicate";
  let result: HandleResult = "ignored";
  const object = event.data.object as { id?: string; subscription?: string | null; customer?: string; client_reference_id?: string | null };
  if (event.type === "checkout.session.completed" && object.customer && object.client_reference_id) {
    await query(
      "INSERT INTO org_billing (org_id, stripe_customer_id) VALUES ($1, $2) ON CONFLICT (org_id) DO NOTHING",
      [object.client_reference_id, object.customer],
    );
    if (object.subscription) {
      await applySubscription(await api<StripeSubscription>("GET", `/subscriptions/${object.subscription}`));
    }
    result = "handled";
  } else if (event.type.startsWith("customer.subscription.") && object.id) {
    try {
      await applySubscription(await api<StripeSubscription>("GET", `/subscriptions/${object.id}`));
    } catch (error) {
      // A deleted subscription may no longer be readable; fall back to the event payload.
      if (!(error instanceof StripeError) || error.status !== 404) throw error;
      await applySubscription(event.data.object as unknown as StripeSubscription);
    }
    result = "handled";
  }
  await query("INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING", [event.id, event.type]);
  return result;
}

/** Keeps the subscription's quantity equal to the organization's seats. Call after membership changes. */
export async function syncSeats(orgId: string, api: StripeApi = stripeRequest): Promise<void> {
  const row = await billingRow(orgId);
  if (!row?.stripe_subscription_id || !row.plan || !ENTITLED.has(row.status ?? "")) return;
  const wanted = Math.max(await seatCount(orgId), MIN_SEATS[row.plan]);
  if (wanted === row.seats) return;
  const sub = await api<StripeSubscription>("GET", `/subscriptions/${row.stripe_subscription_id}`);
  const item = sub.items?.data?.[0];
  if (!item) return;
  await api("POST", `/subscription_items/${item.id}`, { quantity: wanted, proration_behavior: "create_prorations" });
  await query("UPDATE org_billing SET seats = $2, updated_at = now() WHERE org_id = $1", [orgId, wanted]);
}
