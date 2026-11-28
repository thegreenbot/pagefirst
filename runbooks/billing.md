# Set up Stripe billing (hosted service)

Billing is per organization and per seat (editors and above; viewers are free). Stripe is the source of truth: Pagefirst re-reads the subscription on every webhook and sets the organization's plan from it. It only runs where `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are set; self-hosted installs need none of this.

Do this in **test mode** first (toggle *Test mode* in the Stripe dashboard) and repeat in live mode with live keys.

## 1. Products and prices

In *Product catalogue → Add product*, create two products with **recurring** prices **per unit** (per seat):

| Product | Monthly price | Yearly price | Env vars |
| --- | --- | --- | --- |
| Pagefirst Pro | $9 / seat / month | $90 / seat / year | `STRIPE_PRICE_PRO_MONTH`, `STRIPE_PRICE_PRO_YEAR` |
| Pagefirst Team | your price, 3-seat minimum is enforced by the app | your price | `STRIPE_PRICE_TEAM_MONTH`, `STRIPE_PRICE_TEAM_YEAR` |

Open each price and copy its id (`price_...`). Enterprise is sold by contract; set that organization's plan with an operator script, not Stripe.

## 2. API key

*Developers → API keys → Create restricted key*. Give it write access to: Customers, Checkout Sessions, Customer portal sessions (Billing Portal), Subscriptions and Subscription items; read access to Prices. Copy the `rk_...` key as `STRIPE_SECRET_KEY`.

## 3. Customer portal

*Settings → Billing → Customer portal*: turn on cancel subscription, update payment method and invoice history. Turn on *Update subscriptions → quantity* only if you want customers to change seats themselves; Pagefirst also syncs seats from membership.

## 4. Webhook

*Developers → Webhooks → Add endpoint*: URL `https://<your app domain>/api/billing/webhook`, events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the signing secret (`whsec_...`) as `STRIPE_WEBHOOK_SECRET`.

## 5. Vercel environment

Set in the Vercel project (Production): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, the four `STRIPE_PRICE_*` ids, and `PAGEFIRST_EDITION=hosted` (this turns on plan gating). `APP_URL` and `DATABASE_URL` must already be set. Redeploy.

## 6. Check

1. Signed in as an owner, `POST /api/billing/checkout` with `{"orgId": "...", "plan": "pro", "interval": "month"}` returns a Checkout URL. Pay with Stripe's test card `4242 4242 4242 4242`.
2. In *Developers → Webhooks*, the events show 200. `GET /api/billing?orgId=...` reports `plan: "pro"`, `status: "active"`.
3. `POST /api/billing/portal` returns the portal URL; cancel there and confirm the plan returns to `free`.

## How it behaves

- `active`, `trialing` and `past_due` keep the paid plan, so a card retry does not lock customers out. Any other status (`canceled`, `unpaid`, `incomplete_expired`) returns the organization to `free`. Cancelling never deletes the organization or its sites; plan-gated features stop working until it is paid again.
- A price id not listed in the env vars never grants a plan.
- Webhook events are processed once (`stripe_events`) and signatures older than 5 minutes are refused.
- Seat counts change through `syncSeats(orgId)` (`lib/billing/billing.ts`), which must be called after members are added, removed or change role.

Metered API usage (the Bulk API add-on) is not built; it needs its own Stripe meter and is tracked separately.

## Publish limits (#195)

On the hosted edition each plan caps publishing per organization:

| Plan | Live published pages | Publishes per rolling 24 hours |
|---|---|---|
| Free | 10 | 20 |
| Pro | 250 | 500 |
| Team | 2,000 | 2,500 |
| Enterprise | unlimited | unlimited |

Previews are never counted, republishing a live page takes no new slot, and self-hosted installs are unlimited. Override a limit with `PAGEFIRST_LIMIT_<PLAN>_LIVE_PAGES` or `PAGEFIRST_LIMIT_<PLAN>_PUBLISHES_PER_DAY` (a number or `unlimited`), for example `PAGEFIRST_LIMIT_FREE_LIVE_PAGES=15`. A refused publish is recorded in the audit log as `public:plan_limit:<livePages|publishesPerDay>`. The editor shows usage from `GET /api/site/usage`.
