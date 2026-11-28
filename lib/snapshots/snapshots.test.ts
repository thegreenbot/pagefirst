import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import type { DocsDocument } from "@/lib/page/types";
import { commit, type GoogleClient } from "@/lib/service";
import { baseSnapshot, contentHash, lastCommittedSnapshot, lastPublishedSnapshot, latestSnapshotTimes, recordSnapshot, SNAPSHOTS_PER_DOC } from "./store";

const page = (revisionId: string, text = "hello") => {
  const p = aboutFixture();
  p.fileId = "doc-a";
  p.revisionId = revisionId;
  p.metadata.title = text;
  return p;
};

describe("contentHash", () => {
  test("ignores the revision and file id, follows content", () => {
    const a = aboutFixture();
    const b = structuredClone(a);
    b.revisionId = "r99";
    b.fileId = "other";
    assert.equal(contentHash(a), contentHash(b));
    b.metadata.title = "changed";
    assert.notEqual(contentHash(a), contentHash(b));
  });
});

const url = testDatabaseUrl();

describe("snapshots", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM page_snapshots");
  });
  after(async () => {
    await closeDatabase();
  });

  test("stores a snapshot and returns the newest as the base", async () => {
    assert.equal(await baseSnapshot("doc-a"), null);
    assert.equal(await recordSnapshot({ page: page("r1"), source: "commit", actorSub: "u1", docModifiedTime: "2026-11-27T10:00:00Z", modifiedBy: "a@example.com" }), true);
    assert.equal(await recordSnapshot({ page: page("r2", "next"), source: "commit", actorSub: "u1" }), true);
    const base = await baseSnapshot("doc-a");
    assert.equal(base?.revisionId, "r2");
    assert.equal(base?.page.metadata.title, "next");
    const first = await lastCommittedSnapshot("doc-a");
    assert.equal(first?.revisionId, "r2");
    assert.equal(await lastPublishedSnapshot("doc-a"), null);
  });

  test("a retried call, or the same revision and content, is one row", async () => {
    assert.equal(await recordSnapshot({ page: page("r1"), source: "commit", actorSub: "u1" }), true);
    assert.equal(await recordSnapshot({ page: page("r1"), source: "commit", actorSub: "u1" }), false);
    const rows = await query<{ n: string }>("SELECT count(*)::text AS n FROM page_snapshots");
    assert.equal(rows[0]!.n, "1");
  });

  test("keeps Drive attribution and modified time", async () => {
    await recordSnapshot({ page: page("r1"), source: "commit", actorSub: "u1", docModifiedTime: "2026-11-27T10:00:00Z", modifiedBy: "a@example.com" });
    const snapshot = await baseSnapshot("doc-a");
    assert.equal(snapshot?.docModifiedTime, "2026-11-27T10:00:00.000Z");
    assert.equal(snapshot?.modifiedBy, "a@example.com");
  });

  test("publish and commit snapshots are separate; the base is the newer of the two", async () => {
    await recordSnapshot({ page: page("r1"), source: "publish", actorSub: "u1" });
    await recordSnapshot({ page: page("r2", "later"), source: "commit", actorSub: "u1" });
    assert.equal((await lastPublishedSnapshot("doc-a"))?.revisionId, "r1");
    assert.equal((await baseSnapshot("doc-a"))?.revisionId, "r2");
    await recordSnapshot({ page: page("r3", "published later"), source: "publish", actorSub: "u1" });
    assert.equal((await baseSnapshot("doc-a"))?.revisionId, "r3");
  });

  test("retention keeps the newest 20 and always the newest published one", async () => {
    await recordSnapshot({ page: page("p1", "published"), source: "publish", actorSub: "u1" });
    for (let i = 1; i <= SNAPSHOTS_PER_DOC + 5; i++) await recordSnapshot({ page: page(`c${i}`, `edit ${i}`), source: "commit", actorSub: "u1" });
    const rows = await query<{ revision_id: string }>("SELECT revision_id FROM page_snapshots WHERE file_id = 'doc-a' ORDER BY id");
    assert.equal(rows.length, SNAPSHOTS_PER_DOC + 1);
    assert.equal(rows[0]!.revision_id, "p1");
    assert.equal((await lastPublishedSnapshot("doc-a"))?.revisionId, "p1");
    assert.equal(rows[rows.length - 1]!.revision_id, `c${SNAPSHOTS_PER_DOC + 5}`);
  });

  test("latestSnapshotTimes reads one row per Doc in one query", async () => {
    await recordSnapshot({ page: page("r1"), source: "commit", actorSub: "u1", docModifiedTime: "2026-11-27T10:00:00Z" });
    const other = page("x1");
    other.fileId = "doc-b";
    await recordSnapshot({ page: other, source: "commit", actorSub: "u1" });
    const times = await latestSnapshotTimes(["doc-a", "doc-b", "doc-c"]);
    assert.equal(times.size, 2);
    assert.equal(times.get("doc-a")?.docModifiedTime, "2026-11-27T10:00:00.000Z");
  });

  test("a live commit through the service records its snapshot, and survives a Drive failure", async () => {
    const doc = (revisionId: string): DocsDocument => ({
      documentId: "doc-live",
      revisionId,
      title: "Live",
      body: { content: [{ startIndex: 1, endIndex: 7, paragraph: { elements: [{ textRun: { content: "Hello\n" } }] } }] },
      namedRanges: { "pg/node/abc": { name: "pg/node/abc", namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 6 }] }] } },
    });
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    let rev = "rev1";
    const google: GoogleClient = {
      listDocuments: async () => [],
      fetchDocument: async () => doc(rev),
      createDocument: async () => doc(rev),
      batchUpdate: async () => {
        rev = "rev2";
        return {};
      },
      driveMeta: async () => {
        throw new Error("Drive read failed (500)");
      },
    };
    const result = await commit({ actor: { sub: "u1", client: "api" }, googleToken: "tok", requestId: "r", google }, "doc-live", "rev1", [{ op: "replaceText", nodeId: "abc", text: "Hi" }]);
    assert.equal(result.ok, true);
    const snapshot = await baseSnapshot("doc-live");
    assert.equal(snapshot?.revisionId, "rev2");
    assert.equal(snapshot?.source, "commit");
    assert.equal(snapshot?.docModifiedTime, null);
  });
});
