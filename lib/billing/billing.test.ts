import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { addMember, createOrganization, getOrganization } from "@/lib/tenant/orgs";
import { applySubscription, BillingError, billingStatus, handleEvent, startCheckout, startPortal, syncSeats, type StripeApi } from "./billing";
import type { StripeEvent } from "./stripe";

const url = testDatabaseUrl();

type Call = { method: string; path: string; params?: Record<string, unknown> };

function fakeStripe(responses: Record<string, unknown> = {}): { api: StripeApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: StripeApi = async <T,>(method: "GET" | "POST", path: string, params?: Record<string, unknown>) => {
    calls.push({ method, path, params });
    const key = `${method} ${path}`;
    if (key in responses) return responses[key] as T;
    if (path === "/customers") return { id: "cus_1" } as T;
    if (path === "/checkout/sessions") return { url: "https://checkout.stripe.test/c1" } as T;
    if (path === "/billing_portal/sessions") return { url: "https://billing.stripe.test/p1" } as T;
    return {} as T;
  };
  return { api, calls };
}

const sub = (status: string, price = "price_pro_m", quantity = 1, orgId?: string) => ({
  id: "sub_1",
  customer: "cus_1",
  status,
  metadata: orgId ? { org_id: orgId } : {},
  current_period_end: 1_900_000_000,
  items: { data: [{ id: "si_1", quantity, price: { id: price } }] },
});

const event = (id: string, type: string, object: Record<string, unknown>): StripeEvent => ({ id, type, data: { object } });

describe("billing", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgId = "";
  before(async () => {
    process.env.APP_URL = "https://app.example";
    process.env.STRIPE_PRICE_PRO_MONTH = "price_pro_m";
    process.env.STRIPE_PRICE_PRO_YEAR = "price_pro_y";
    process.env.STRIPE_PRICE_TEAM_MONTH = "price_team_m";
    process.env.STRIPE_PRICE_TEAM_YEAR = "price_team_y";
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM stripe_events");
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    await upsertUser("owner", "o@example.com");
    await upsertUser("viewer", "v@example.com");
    orgId = (await createOrganization("owner", "Acme")).id;
    await addMember(orgId, "viewer", "viewer");
  });
  after(closeDatabase);

  test("checkout creates a customer once and sends seats and the org in the session", async () => {
    const { api, calls } = fakeStripe();
    const { url: checkout } = await startCheckout({ orgId, sub: "owner", plan: "pro", interval: "month" }, api);
    assert.equal(checkout, "https://checkout.stripe.test/c1");
    const session = calls.find((c) => c.path === "/checkout/sessions")!.params!;
    assert.equal(session.client_reference_id, orgId);
    assert.deepEqual(session.line_items, [{ price: "price_pro_m", quantity: 1 }]);
    await startCheckout({ orgId, sub: "owner", plan: "pro", interval: "year" }, api);
    assert.equal(calls.filter((c) => c.path === "/customers").length, 1);
  });

  test("team needs at least three seats", async () => {
    const { api, calls } = fakeStripe();
    await startCheckout({ orgId, sub: "owner", plan: "team", interval: "month" }, api);
    assert.deepEqual(calls.find((c) => c.path === "/checkout/sessions")!.params!.line_items, [{ price: "price_team_m", quantity: 3 }]);
  });

  test("only an owner or admin can start checkout or the portal", async () => {
    const { api } = fakeStripe();
    await assert.rejects(startCheckout({ orgId, sub: "viewer", plan: "pro", interval: "month" }, api), (e) => e instanceof BillingError && e.status === 403);
    await assert.rejects(startCheckout({ orgId, sub: "stranger", plan: "pro", interval: "month" }, api), (e) => e instanceof BillingError && e.status === 403);
    await assert.rejects(startPortal({ orgId, sub: "viewer" }, api), (e) => e instanceof BillingError && e.status === 403);
  });

  test("the portal needs a billing account, and an unknown price is refused", async () => {
    const { api } = fakeStripe();
    await assert.rejects(startPortal({ orgId, sub: "owner" }, api), (e) => e instanceof BillingError && e.status === 404);
    delete process.env.STRIPE_PRICE_PRO_YEAR;
    await assert.rejects(startCheckout({ orgId, sub: "owner", plan: "pro", interval: "year" }, api), (e) => e instanceof BillingError && e.status === 400);
    process.env.STRIPE_PRICE_PRO_YEAR = "price_pro_y";
  });

  test("an active subscription sets the plan; cancelling returns to free", async () => {
    const { api } = fakeStripe({ "GET /subscriptions/sub_1": sub("active", "price_team_y", 4, orgId) });
    assert.equal(await handleEvent(event("evt_1", "customer.subscription.created", { id: "sub_1" }), api), "handled");
    assert.equal((await getOrganization(orgId))?.plan, "team");
    const status = await billingStatus(orgId, "team");
    assert.deepEqual([status.status, status.interval, status.seats], ["active", "year", 4]);
    assert.ok(status.currentPeriodEnd);

    const cancelled = fakeStripe({ "GET /subscriptions/sub_1": sub("canceled", "price_team_y", 4, orgId) });
    await handleEvent(event("evt_2", "customer.subscription.deleted", { id: "sub_1" }), cancelled.api);
    assert.equal((await getOrganization(orgId))?.plan, "free");
  });

  test("a payment failure keeps the plan until Stripe cancels, then drops it", async () => {
    await applySubscription(sub("active", "price_pro_m", 1, orgId));
    await applySubscription(sub("past_due", "price_pro_m", 1, orgId));
    assert.equal((await getOrganization(orgId))?.plan, "pro");
    await applySubscription(sub("unpaid", "price_pro_m", 1, orgId));
    assert.equal((await getOrganization(orgId))?.plan, "free");
  });

  test("a price we don't know about never grants a plan", async () => {
    await applySubscription(sub("active", "price_unknown", 1, orgId));
    assert.equal((await getOrganization(orgId))?.plan, "free");
  });

  test("a replayed event is handled once", async () => {
    const { api, calls } = fakeStripe({ "GET /subscriptions/sub_1": sub("active", "price_pro_m", 1, orgId) });
    const e = event("evt_dup", "customer.subscription.updated", { id: "sub_1" });
    assert.equal(await handleEvent(e, api), "handled");
    assert.equal(await handleEvent(e, api), "duplicate");
    assert.equal(calls.length, 1);
  });

  test("an old event cannot undo newer state: the subscription is re-read from Stripe", async () => {
    const { api } = fakeStripe({ "GET /subscriptions/sub_1": sub("active", "price_team_m", 3, orgId) });
    await handleEvent(event("evt_old", "customer.subscription.updated", { id: "sub_1", status: "canceled" }), api);
    assert.equal((await getOrganization(orgId))?.plan, "team");
  });

  test("checkout.session.completed links the customer and applies the subscription", async () => {
    const { api } = fakeStripe({ "GET /subscriptions/sub_1": sub("trialing", "price_pro_m", 1, orgId) });
    await handleEvent(event("evt_c", "checkout.session.completed", { customer: "cus_1", client_reference_id: orgId, subscription: "sub_1" }), api);
    assert.equal((await getOrganization(orgId))?.plan, "pro");
  });

  test("unrelated events are ignored but recorded", async () => {
    const { api, calls } = fakeStripe();
    assert.equal(await handleEvent(event("evt_x", "invoice.created", { id: "in_1" }), api), "ignored");
    assert.equal(calls.length, 0);
  });

  test("seats follow membership, never below the plan minimum, and viewers are free", async () => {
    await applySubscription(sub("active", "price_team_m", 3, orgId));
    const { api, calls } = fakeStripe({ "GET /subscriptions/sub_1": sub("active", "price_team_m", 3, orgId) });
    await syncSeats(orgId, api);
    assert.equal(calls.length, 0, "1 owner + 1 viewer is under the team minimum of 3, so nothing changes");
    for (const name of ["e1", "e2", "e3"]) {
      await upsertUser(name, `${name}@example.com`);
      await addMember(orgId, name, "editor");
    }
    await syncSeats(orgId, api);
    const update = calls.find((c) => c.method === "POST")!;
    assert.equal(update.path, "/subscription_items/si_1");
    assert.equal(update.params!.quantity, 4);
    assert.equal((await billingStatus(orgId, "team")).seats, 4);
  });

  test("syncSeats does nothing without a live subscription", async () => {
    const { api, calls } = fakeStripe();
    await syncSeats(orgId, api);
    assert.equal(calls.length, 0);
  });
});
