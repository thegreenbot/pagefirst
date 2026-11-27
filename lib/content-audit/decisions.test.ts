import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { decisionsFor, isDecision, isFinding, recordDecision } from "./decisions";

const url = testDatabaseUrl();

describe("audit decisions", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM content_audit_decisions");
  });
  after(closeDatabase);

  test("decisions accumulate as history, newest first", async () => {
    await upsertUser("sub-a", "a@example.com");
    await recordDecision({ fileId: "doc1", actorSub: "sub-a", finding: "thin", decision: "noindex", note: "placeholder" });
    await recordDecision({ fileId: "doc1", actorSub: "sub-a", finding: "thin", decision: "update", revisionId: "rev9" });
    await recordDecision({ fileId: "doc2", actorSub: null, finding: "stale", decision: "keep" });
    const history = await decisionsFor("doc1");
    assert.deepEqual(history.map((d) => d.decision), ["update", "noindex"]);
    assert.equal(history[0].revisionId, "rev9");
    assert.equal(history[1].note, "placeholder");
    assert.equal((await decisionsFor("doc2")).length, 1);
  });

  test("the database rejects unknown values", async () => {
    await assert.rejects(query("INSERT INTO content_audit_decisions (file_id, finding, decision) VALUES ('d', 'thin', 'explode')"));
  });
});

test("type guards", () => {
  assert.ok(isFinding("thin") && !isFinding("big"));
  assert.ok(isDecision("merge") && !isDecision("delete"));
});
