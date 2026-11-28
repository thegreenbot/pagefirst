import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import type { DocsDocument } from "@/lib/page/types";
import { parseDocument } from "@/lib/page/parse";
import { recordSnapshot } from "@/lib/snapshots/store";
import { getPage, listPages, type GoogleClient, type ServiceContext } from "./index";

const doc = (id: string, revisionId: string, text = "Hello"): DocsDocument => ({
  documentId: id,
  revisionId,
  title: id,
  body: { content: [{ startIndex: 1, endIndex: text.length + 2, paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] },
  namedRanges: { "pg/node/abc": { name: "pg/node/abc", namedRanges: [{ ranges: [{ startIndex: 1, endIndex: text.length + 1 }] }] } },
});

const url = testDatabaseUrl();

describe("changed in Google Doc", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM page_snapshots");
  });
  after(async () => {
    await closeDatabase();
  });

  let listCalls = 0;
  let docCalls = 0;
  const google = (files: { id: string; name: string; modifiedTime?: string }[], current: Record<string, string>): GoogleClient => ({
    listDocuments: async () => {
      listCalls++;
      return files;
    },
    fetchDocument: async (_token, fileId) => {
      docCalls++;
      return doc(fileId, current[fileId] ?? "rev1");
    },
    createDocument: async () => doc("x", "r"),
    batchUpdate: async () => ({}),
    driveMeta: async () => ({ modifiedTime: "2026-11-27T12:00:00Z", lastModifiedBy: { name: "Pat", email: "pat@example.com" } }),
  });
  const ctx = (g: GoogleClient): ServiceContext => ({ actor: { sub: "u1", client: "api" }, googleToken: "tok", requestId: "r", google: g });

  async function snapshot(fileId: string, revisionId: string, docModifiedTime: string | null) {
    await recordSnapshot({ page: parseDocument(doc(fileId, revisionId), fileId), source: "commit", actorSub: "u1", docModifiedTime });
  }

  test("the listing marks Docs edited after their snapshot, with one list call and no Docs reads", async () => {
    await snapshot("edited", "rev1", "2026-11-27T10:00:00Z");
    await snapshot("untouched", "rev1", "2026-11-27T10:00:00Z");
    const files = [
      { id: "edited", name: "Edited", modifiedTime: "2026-11-27T11:30:00Z" },
      { id: "untouched", name: "Untouched", modifiedTime: "2026-11-27T10:00:00Z" },
      { id: "never", name: "Never", modifiedTime: "2026-11-27T09:00:00Z" },
    ];
    listCalls = 0;
    docCalls = 0;
    const { pages } = await listPages(ctx(google(files, {})));
    assert.equal(listCalls, 1);
    assert.equal(docCalls, 0);
    const by = Object.fromEntries(pages.map((page) => [page.fileId, page.changed]));
    assert.deepEqual(by, { edited: true, untouched: false, never: undefined });
  });

  test("changed=true lists only the edited Docs", async () => {
    await snapshot("edited", "rev1", "2026-11-27T10:00:00Z");
    await snapshot("untouched", "rev1", "2026-11-27T10:00:00Z");
    const files = [
      { id: "edited", name: "Edited", modifiedTime: "2026-11-27T11:30:00Z" },
      { id: "untouched", name: "Untouched", modifiedTime: "2026-11-27T10:00:00Z" },
    ];
    const { pages } = await listPages(ctx(google(files, {})), { changed: true });
    assert.deepEqual(pages.map((page) => page.fileId), ["edited"]);
  });

  test("a snapshot without a Drive time falls back to when it was taken", async () => {
    await snapshot("old", "rev1", null);
    const files = [{ id: "old", name: "Old", modifiedTime: new Date(Date.now() + 60_000).toISOString() }];
    const { pages } = await listPages(ctx(google(files, {})));
    assert.equal(pages[0]!.changed, true);
  });

  test("a page whose revision moved on reports who and when", async () => {
    await snapshot("p1", "rev1", "2026-11-27T10:00:00Z");
    const changed = await getPage(ctx(google([], { p1: "rev2" })), "p1");
    assert.deepEqual(changed?.changedInDoc, { baseRevisionId: "rev1", modifiedTime: "2026-11-27T12:00:00Z", modifiedBy: "pat@example.com" });
    const same = await getPage(ctx(google([], { p1: "rev1" })), "p1");
    assert.equal(same?.changedInDoc, undefined);
    const untouched = await getPage(ctx(google([], { fresh: "rev9" })), "fresh");
    assert.equal(untouched?.changedInDoc, undefined);
  });

  test("a Drive failure still reports the change", async () => {
    await snapshot("p2", "rev1", null);
    const g = { ...google([], { p2: "rev2" }), driveMeta: async () => { throw new Error("Drive read failed (500)"); } };
    const result = await getPage(ctx(g), "p2");
    assert.deepEqual(result?.changedInDoc, { baseRevisionId: "rev1", modifiedTime: null, modifiedBy: null });
  });
});
