import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import type { DocsDocument } from "@/lib/page/types";
import { getImport } from "@/lib/import/store";
import { baseSnapshot, recordSnapshot } from "@/lib/snapshots/store";
import { parseDocument } from "@/lib/page/parse";
import { recordAudit } from "@/lib/audit";
import { importAndPublish, importPage, publish, ServiceError, type GoogleClient, type ServiceContext } from "./index";

type Range = { startIndex: number; endIndex: number };

function makeDoc(texts: string[], named: boolean): DocsDocument {
  return {
    documentId: "doc1",
    revisionId: "rev1",
    title: "Doc",
    body: {
      content: texts.map((text, i) => ({
        startIndex: 1 + 10 * i,
        endIndex: 11 + 10 * i,
        paragraph: { elements: [{ textRun: { content: `${text}\n` } }], paragraphStyle: { namedStyleType: i === 0 ? "HEADING_1" : "NORMAL_TEXT" } },
      })),
    },
    namedRanges: named
      ? Object.fromEntries(texts.map((_, i) => [`pg/node/n${i}`, { name: `pg/node/n${i}`, namedRanges: [{ namedRangeId: `r${i}`, name: `pg/node/n${i}`, ranges: [{ startIndex: 1 + 10 * i, endIndex: 10 + 10 * i }] }] }]))
      : {},
  } as DocsDocument;
}

function fake(initial: DocsDocument) {
  const doc = initial;
  let revision = 1;
  const writes: object[][] = [];
  const bump = () => {
    revision += 1;
    doc.revisionId = `rev${revision}`;
  };
  const google: GoogleClient = {
    listDocuments: async () => [],
    fetchDocument: async () => structuredClone(doc),
    createDocument: async () => structuredClone(doc),
    batchUpdate: async (_token, _fileId, requests) => {
      writes.push(requests);
      for (const request of requests as { createNamedRange?: { name: string; range: Range }; deleteNamedRange?: { name: string } }[]) {
        doc.namedRanges ??= {};
        if (request.deleteNamedRange) delete doc.namedRanges[request.deleteNamedRange.name];
        if (request.createNamedRange) {
          const { name, range } = request.createNamedRange;
          (doc.namedRanges[name] ??= { name, namedRanges: [] }).namedRanges!.push({ namedRangeId: `x${Math.random()}`, name, ranges: [range] } as never);
        }
      }
      bump();
      return {};
    },
    driveMeta: async () => ({ modifiedTime: "2026-11-27T12:00:00Z", lastModifiedBy: { name: "Pat", email: "pat@example.com" } }),
  };
  return {
    google,
    writes,
    /** Someone edits paragraph `i` in Google Docs. */
    edit(i: number, text: string) {
      (doc.body!.content![i]!.paragraph!.elements![0]!.textRun!.content as string) = `${text}\n`;
      bump();
    },
    suggest() {
      (doc.body!.content![1]!.paragraph!.elements![0] as Record<string, unknown>).suggestedInsertionIds = ["sug1"];
      bump();
    },
    get doc() {
      return doc;
    },
  };
}

const url = testDatabaseUrl();

describe("import service", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM page_snapshots");
    await query("DELETE FROM page_imports");
  });
  after(async () => {
    await closeDatabase();
  });

  const ctx = (google: GoogleClient, extra: Partial<ServiceContext> = {}): ServiceContext => ({ actor: { sub: "u1", client: "api" }, googleToken: "tok", requestId: "r", google, ...extra });

  test("a dry run reports and writes nothing", async () => {
    const f = fake(makeDoc(["Title", "Body"], false));
    const result = await importPage(ctx(f.google), "doc1", { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.equal(result.firstImport, true);
    assert.equal(f.writes.length, 0);
    assert.equal(result.adopt.adopted, 2);
    assert.ok(result.changes.some((change) => change.kind === "node.untracked"));
    assert.equal(await baseSnapshot("doc1"), null);
    const row = await getImport(result.importId);
    assert.equal(row?.dryRun, true);
    assert.equal(row?.docAuthor, "pat@example.com");
  });

  test("the first real import adopts, snapshots, and a second import of the same revision writes nothing", async () => {
    const f = fake(makeDoc(["Title", "Body"], false));
    const first = await importPage(ctx(f.google), "doc1", { dryRun: false });
    assert.equal(f.writes.length, 1);
    assert.equal(first.adopt.adopted, 2);
    const snapshot = await baseSnapshot("doc1");
    assert.equal(snapshot?.source, "import");
    assert.equal(snapshot?.importId, first.importId);
    assert.equal(snapshot?.revisionId, first.toRevisionId);

    const second = await importPage(ctx(f.google), "doc1", { dryRun: false });
    assert.equal(f.writes.length, 1);
    assert.deepEqual(second.changes, []);
    assert.equal(second.fromRevisionId, first.toRevisionId);
    assert.equal(second.adopt.adopted, 0);
  });

  test("an edit made in Google Docs shows up as a text change between the two revisions", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    const first = await importPage(ctx(f.google), "doc1", { dryRun: false });
    f.edit(1, "Body, edited");
    const dry = await importPage(ctx(f.google), "doc1", { dryRun: true });
    assert.equal(dry.fromRevisionId, first.toRevisionId);
    assert.notEqual(dry.toRevisionId, first.toRevisionId);
    assert.deepEqual(dry.changes.map((c) => c.kind), ["prose.text"]);
    assert.equal((await baseSnapshot("doc1"))?.revisionId, first.toRevisionId, "a dry run leaves the base alone");
    const real = await importPage(ctx(f.google), "doc1", { dryRun: false });
    assert.equal((await baseSnapshot("doc1"))?.revisionId, real.toRevisionId);
    assert.equal(real.docAuthor, "pat@example.com");
  });

  test("a draft that changed the same text conflicts; manual holds the snapshot back", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    await importPage(ctx(f.google), "doc1", { dryRun: false });
    const base = await baseSnapshot("doc1");
    f.edit(1, "Doc says this");
    const result = await importPage(ctx(f.google), "doc1", { dryRun: false, draftOps: [{ op: "replaceText", nodeId: "n1", text: "Draft says that" }] });
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.needsReview, true);
    assert.equal((await baseSnapshot("doc1"))?.revisionId, base?.revisionId, "no new base until the conflict is settled");
    const docWins = await importPage(ctx(f.google), "doc1", { dryRun: false, policy: "doc-wins", draftOps: [{ op: "replaceText", nodeId: "n1", text: "Draft says that" }] });
    assert.equal(docWins.needsReview, false);
    assert.equal(docWins.conflicts[0]!.kept, "doc");
    assert.notEqual((await baseSnapshot("doc1"))?.revisionId, base?.revisionId);
  });

  test("pending suggestions are reported, and block a public publish unless allowed", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    f.suggest();
    const result = await importPage(ctx(f.google), "doc1", { dryRun: true });
    assert.equal(result.opaque.suggestions, 1);
    await assert.rejects(publish(ctx(f.google), "doc1", { public: true }), (error: unknown) => error instanceof ServiceError && error.code === "suggestions_pending");
  });

  test("importAndPublish pins the publish to the imported revision and records the link", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    const done = await importAndPublish(ctx(f.google), "doc1", {});
    assert.equal(done.reason, null);
    assert.equal(done.publish?.response.ok, true);
    assert.equal(done.publish?.audit.resultRevisionId, done.import.toRevisionId);
    assert.equal(done.publish?.audit.importId, done.import.importId);
  });

  test("importAndPublish holds back when a conflict needs a person", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    await importPage(ctx(f.google), "doc1", { dryRun: false });
    f.edit(1, "Doc says this");
    const held = await importAndPublish(ctx(f.google), "doc1", { draftOps: [{ op: "replaceText", nodeId: "n1", text: "Draft" }] });
    assert.equal(held.reason, "conflicts");
    assert.equal(held.publish, null);
  });

  test("a read-only credential cannot import; the folder allow-list applies", async () => {
    const f = fake(makeDoc(["Title"], true));
    await assert.rejects(importPage(ctx(f.google, { scopes: new Set(["pages:read" as const]) }), "doc1"), /pages:import/);
    await assert.rejects(importPage(ctx(f.google, { siteFolders: ["folderfolderfolder"] }), "doc1"), (error: unknown) => error instanceof ServiceError && error.code === "forbidden");
  });

  test("snapshots keep ids stable: a Doc with untracked content parses to the same page after adopt", async () => {
    const f = fake(makeDoc(["Title", "Body"], false));
    await importPage(ctx(f.google), "doc1", { dryRun: false });
    const first = parseDocument(f.doc);
    const second = parseDocument(structuredClone(f.doc));
    assert.deepEqual(first.sections.map((s) => s.children.map((n) => n.id)), second.sections.map((s) => s.children.map((n) => n.id)));
    await recordSnapshot({ page: first, source: "commit", actorSub: "u1" });
  });

  test("an audit entry carries the import id, the Drive author and the change count", async () => {
    await query("DELETE FROM audit_events").catch(() => undefined);
    await recordAudit({ event: "page.import", outcome: "ok", actorSub: "u1", client: "api", fileId: "doc1", importId: "imp_abc", docAuthor: "pat@example.com", changeCount: 3 });
    await recordAudit({ event: "page.publish", outcome: "ok", actorSub: "u1", client: "api", fileId: "doc1", importId: "imp_abc", docAuthor: "pat@example.com", changeCount: 3 });
    const rows = await query<{ event: string; import_id: string; doc_author: string; change_count: number }>("SELECT event, import_id, doc_author, change_count FROM audit_events ORDER BY id");
    assert.deepEqual(rows.map((row) => [row.event, row.import_id, row.doc_author, row.change_count]), [["page.import", "imp_abc", "pat@example.com", 3], ["page.publish", "imp_abc", "pat@example.com", 3]]);
  });
});
