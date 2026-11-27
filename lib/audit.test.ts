import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { auditAdmins, auditEventsFor, hashIp, pruneAuditEvents, recordAudit, requestIdFrom } from "./audit";

const url = testDatabaseUrl();

describe("audit helpers", () => {
  test("keeps a well-formed request id and replaces a hostile one", () => {
    assert.equal(requestIdFrom(new Request("http://x/", { headers: { "x-request-id": "iad1::abc-123" } })), "iad1::abc-123");
    const replaced = requestIdFrom(new Request("http://x/", { headers: { "x-request-id": "<script>\n" } }));
    assert.match(replaced, /^[0-9a-f-]{36}$/);
  });

  test("hashes IPs so the address is never stored", () => {
    const hashed = hashIp("203.0.113.9");
    assert.ok(hashed);
    assert.ok(!hashed.includes("203.0.113.9"));
    assert.equal(hashed, hashIp("203.0.113.9"));
    assert.equal(hashIp(null), null);
  });

  test("reads admin emails case-insensitively", () => {
    process.env.AUDIT_ADMIN_EMAILS = "Admin@Example.com, other@example.com";
    assert.deepEqual([...auditAdmins()], ["admin@example.com", "other@example.com"]);
    delete process.env.AUDIT_ADMIN_EMAILS;
  });
});

describe("audit log in Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await pruneAuditEvents(-1);
  });
  after(async () => {
    await closeDatabase();
  });

  test("records metadata, never Doc text or tokens", async () => {
    await recordAudit({
      event: "page.commit",
      outcome: "error",
      actorSub: "u1",
      fileId: "doc1",
      baseRevisionId: "rev-1",
      ops: [
        { op: "replaceText", nodeId: "b1", text: "SECRET-DOC-TEXT" },
        { op: "replaceText", nodeId: "b2", text: "more" },
      ],
      status: 502,
      errorCode: "Google said ya29.leaked-token-value",
      ip: "203.0.113.9",
    });
    const rows = await query("SELECT * FROM audit_events");
    assert.equal(rows.length, 1);
    const dump = JSON.stringify(rows);
    for (const secret of ["SECRET-DOC-TEXT", "ya29.leaked-token-value", "203.0.113.9"]) assert.ok(!dump.includes(secret), secret);
    const [row] = await auditEventsFor("u1");
    assert.equal(row?.op_count, 2);
    assert.deepEqual(row?.op_kinds, ["replaceText"]);
    assert.equal(row?.status, 502);
  });

  test("refuses UPDATE, DELETE and TRUNCATE", async () => {
    await recordAudit({ event: "auth.sign_in", outcome: "ok", actorSub: "u2" });
    await assert.rejects(query("UPDATE audit_events SET outcome = 'denied'"), /append-only/);
    await assert.rejects(query("DELETE FROM audit_events"), /append-only/);
    await assert.rejects(query("TRUNCATE audit_events"), /append-only/);
    assert.equal((await auditEventsFor("u2")).length, 1);
  });

  test("retention deletes only old events, and only through the maintenance path", async () => {
    await recordAudit({ event: "auth.sign_in", outcome: "ok", actorSub: "u3" });
    assert.equal(await pruneAuditEvents(400), 0);
    assert.equal(await pruneAuditEvents(-1), 1);
    // The setting was local to that transaction.
    await recordAudit({ event: "auth.sign_in", outcome: "ok", actorSub: "u3" });
    await assert.rejects(query("DELETE FROM audit_events"), /append-only/);
  });

  test("a failed write never throws", async () => {
    await assert.doesNotReject(recordAudit({ event: "auth.sign_in", outcome: "bogus" as never }));
  });
});
