import assert from "node:assert/strict";
import test from "node:test";
import { encodeForm, signWebhook, verifyWebhook } from "./stripe";

const secret = "whsec_test";
const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
const now = 1_800_000_000;

test("encodeForm nests objects and arrays the way Stripe expects", () => {
  const out = decodeURIComponent(encodeForm({ mode: "subscription", line_items: [{ price: "price_1", quantity: 3 }], subscription_data: { metadata: { org_id: "o" } }, skip: undefined }));
  assert.equal(out, "mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=3&subscription_data[metadata][org_id]=o");
});

test("a correctly signed body verifies", () => {
  const event = verifyWebhook(body, signWebhook(body, secret, now), secret, now);
  assert.equal(event?.id, "evt_1");
});

test("a wrong secret, edited body or stale timestamp is refused", () => {
  assert.equal(verifyWebhook(body, signWebhook(body, "other", now), secret, now), null);
  assert.equal(verifyWebhook(`${body} `, signWebhook(body, secret, now), secret, now), null);
  assert.equal(verifyWebhook(body, signWebhook(body, secret, now - 600), secret, now), null);
});

test("missing or malformed headers are refused", () => {
  assert.equal(verifyWebhook(body, null, secret, now), null);
  assert.equal(verifyWebhook(body, "garbage", secret, now), null);
  assert.equal(verifyWebhook(body, `t=${now},v1=zz`, secret, now), null);
});

test("any one matching v1 signature is enough, for secret rotation", () => {
  const good = signWebhook(body, secret, now);
  assert.ok(verifyWebhook(body, `${good},v1=${"0".repeat(64)}`, secret, now));
});
