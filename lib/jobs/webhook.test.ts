import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { claimItems, createJob, finishItem, settleJob } from "./store";
import { deliverDue, MAX_ATTEMPTS, RETRY_DELAYS_MS, sign, verifySignature, type Send } from "./webhook";

const url = testDatabaseUrl();

describe("webhook signatures", () => {
  test("verify a good signature and reject a changed body, wrong secret, bad header or old timestamp", () => {
    const secret = "s".repeat(20);
    const now = 1_800_000_000_000;
    const t = now / 1000;
    const header = sign(secret, t, '{"a":1}');
    assert.equal(verifySignature(secret, header, '{"a":1}', now), true);
    assert.equal(verifySignature(secret, header, '{"a":2}', now), false);
    assert.equal(verifySignature("x".repeat(20), header, '{"a":1}', now), false);
    assert.equal(verifySignature(secret, "garbage", '{"a":1}', now), false);
    assert.equal(verifySignature(secret, header, '{"a":1}', now + 10 * 60_000), false);
  });
});

// The database stamps rows with microseconds, JS with milliseconds: a clock a little ahead keeps "due now" unambiguous.
const soon = () => new Date(Date.now() + 5_000);

describe("completion webhooks in Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  async function finishedJob(credentialId: string, secret = "hook-secret-0123456789") {
    const job = await createJob({
      credentialId,
      sub: "u1",
      scopes: ["pages:commit"],
      kind: "commit",
      dryRun: false,
      policy: {},
      items: [{ fileId: "f1", params: {} }],
      webhook: { url: "https://hooks.example.com/pf", secret },
    });
    const [item] = await claimItems(job.id, 1);
    await finishItem(job.id, item!.idx, "ok");
    assert.equal(await settleJob(job.id), "done");
    return job;
  }

  test("a finished job is delivered once, signed, with counts and no page content", async () => {
    const job = await finishedJob("c-hook-1");
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const send: Send = async (u, headers, body) => {
      calls.push({ url: u.toString(), headers, body });
      return 204;
    };
    assert.deepEqual(await deliverDue(5, send, soon()), { sent: 1, failed: 0 });
    assert.equal(calls.length, 1);
    const body = JSON.parse(calls[0]!.body);
    assert.equal(body.event, "job.completed");
    assert.equal(body.job.id, job.id);
    assert.equal(body.counts.ok, 1);
    assert.ok(verifySignature("hook-secret-0123456789", calls[0]!.headers["Pagefirst-Signature"]!, calls[0]!.body));
    assert.deepEqual(await deliverDue(5, send, soon()), { sent: 0, failed: 0 }, "not sent twice");
    // Settling again does not queue another delivery.
    await settleJob(job.id);
    assert.deepEqual(await deliverDue(5, send, soon()), { sent: 0, failed: 0 });
  });

  test("failures back off, then give up after the last attempt", async () => {
    const job = await finishedJob("c-hook-2");
    const send: Send = async () => 500;
    let now = soon();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await deliverDue(5, send, now);
      assert.deepEqual(result, { sent: 0, failed: 1 }, `attempt ${attempt}`);
      // Nothing is due again before the backoff has passed.
      assert.deepEqual(await deliverDue(5, send, new Date(now.getTime() + 1000)), { sent: 0, failed: 0 });
      now = new Date(now.getTime() + (RETRY_DELAYS_MS[attempt - 1] ?? 0) + 1000);
    }
    const [row] = await query<{ webhook_state: string; webhook_attempts: number }>("SELECT webhook_state, webhook_attempts FROM jobs WHERE id = $1", [job.id]);
    assert.equal(row!.webhook_state, "failed");
    assert.equal(row!.webhook_attempts, MAX_ATTEMPTS);
    assert.deepEqual(await deliverDue(5, send, now), { sent: 0, failed: 0 });
  });

  test("a thrown send (timeout, refused address) counts as a failure and the secret is stored sealed", async () => {
    const job = await finishedJob("c-hook-3");
    const [stored] = await query<{ webhook_secret: string }>("SELECT webhook_secret FROM jobs WHERE id = $1", [job.id]);
    assert.ok(!stored!.webhook_secret.includes("hook-secret"));
    const send: Send = async () => {
      throw new Error("boom");
    };
    assert.deepEqual(await deliverDue(5, send, soon()), { sent: 0, failed: 1 });
  });

  test("a job with no webhook never queues one", async () => {
    const job = await createJob({ credentialId: "c-hook-4", sub: "u1", scopes: ["pages:commit"], kind: "commit", dryRun: false, policy: {}, items: [{ fileId: "f1", params: {} }] });
    const [item] = await claimItems(job.id, 1);
    await finishItem(job.id, item!.idx, "ok");
    await settleJob(job.id);
    const [row] = await query<{ webhook_state: string }>("SELECT webhook_state FROM jobs WHERE id = $1", [job.id]);
    assert.equal(row!.webhook_state, "none");
  });
});
