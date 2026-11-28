import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { duplicateIds, FIRST_SECTION_ID, parseDocument } from "@/lib/page/parse";
import type { DocsDocument, Page } from "@/lib/page/types";
import { adoptPage, type GoogleClient } from "@/lib/service";
import { planAdopt } from "./adopt";

type Range = { startIndex: number; endIndex: number };

/** Paragraph i spans [1 + 10i, 11 + 10i); a named range over its text is [1 + 10i, 10 + 10i). */
function docWith(texts: string[], ranges: Record<string, Range[]>, tags: Record<number, string> = {}): DocsDocument {
  return {
    documentId: "doc",
    revisionId: "rev1",
    title: "Doc",
    body: {
      content: texts.map((text, i) => ({
        startIndex: 1 + 10 * i,
        endIndex: 11 + 10 * i,
        paragraph: { elements: [{ textRun: { content: `${text}\n` } }], paragraphStyle: { namedStyleType: tags[i] ?? "NORMAL_TEXT" } },
      })),
    },
    namedRanges: Object.fromEntries(Object.entries(ranges).map(([name, rs]) => [name, { name, namedRanges: [{ namedRangeId: `id-${name}`, name, ranges: rs }] }])),
  } as DocsDocument;
}

const span = (i: number): Range => ({ startIndex: 1 + 10 * i, endIndex: 10 + 10 * i });

/** Applies the named-range requests to a Doc, the way Google would. */
function apply(doc: DocsDocument, requests: object[]): DocsDocument {
  const next = structuredClone(doc);
  next.revisionId = `${doc.revisionId}+`;
  const ranges = (next.namedRanges ??= {});
  for (const request of requests as { createNamedRange?: { name: string; range: Range }; deleteNamedRange?: { name: string } }[]) {
    if (request.deleteNamedRange) delete ranges[request.deleteNamedRange.name];
    if (request.createNamedRange) {
      const { name, range } = request.createNamedRange;
      ranges[name] ??= { name, namedRanges: [] };
      ranges[name]!.namedRanges!.push({ namedRangeId: `n${Math.random()}`, name, ranges: [range] } as never);
    }
  }
  return next;
}

const ids = (page: Page) => page.sections.flatMap((s) => s.children.map((n) => n.id));

describe("planAdopt", () => {
  test("a fully tracked Doc needs no writes", () => {
    const doc = docWith(["One", "Two"], { "pg/node/a": [span(0)], "pg/node/b": [span(1)] });
    const plan = planAdopt(doc);
    assert.deepEqual(plan.requests, []);
    assert.deepEqual(plan.report, { adopted: 0, duplicated: [], orphans: [], reanchored: [] });
    assert.deepEqual(ids(parseDocument(doc)), ["a", "b"]);
  });

  test("pasted content with no ranges is adopted once; a second pass writes nothing and ids hold", () => {
    const doc = docWith(["One", "Two", "Three"], {});
    const plan = planAdopt(doc);
    assert.equal(plan.report.adopted, 3);
    assert.ok(plan.requests.every((r) => "createNamedRange" in r));
    const adopted = apply(doc, plan.requests);
    assert.deepEqual(planAdopt(adopted).requests, []);
    assert.deepEqual(ids(parseDocument(adopted)), ids(parseDocument(adopted)));
    assert.equal(new Set(ids(parseDocument(adopted))).size, 3);
  });

  test("only the untracked node is adopted; tracked ids are untouched", () => {
    const doc = docWith(["One", "Two", "Three"], { "pg/node/a": [span(0)], "pg/node/c": [span(2)] });
    const plan = planAdopt(doc);
    assert.equal(plan.requests.length, 1);
    const after = parseDocument(apply(doc, plan.requests));
    assert.equal(after.sections[0]!.children[0]!.id, "a");
    assert.equal(after.sections[0]!.children[2]!.id, "c");
  });

  test("a range that now covers two paragraphs is re-anchored to the first; the second gets a new id", () => {
    const doc = docWith(["One", "Two"], { "pg/node/a": [{ startIndex: 1, endIndex: 20 }] });
    const plan = planAdopt(doc);
    assert.deepEqual(plan.report.reanchored, ["pg/node/a"]);
    assert.deepEqual(plan.report.orphans, ["pg/node/a"]);
    const after = apply(doc, plan.requests);
    const page = parseDocument(after);
    assert.equal(page.sections[0]!.children[0]!.id, "a");
    assert.notEqual(page.sections[0]!.children[1]!.id, "a");
    assert.deepEqual(planAdopt(after).requests, []);
  });

  test("a range left behind with no paragraph is removed and reported", () => {
    const doc = docWith(["One"], { "pg/node/a": [span(0)], "pg/node/gone": [{ startIndex: 500, endIndex: 520 }] });
    const plan = planAdopt(doc);
    assert.deepEqual(plan.report.orphans, ["pg/node/gone"]);
    assert.deepEqual(plan.report.reanchored, []);
    assert.deepEqual(plan.requests, [{ deleteNamedRange: { name: "pg/node/gone" } }]);
  });

  test("a range copied with its text gives the copy a new id", () => {
    const doc = docWith(["One", "One"], { "pg/node/a": [span(0), span(1)] });
    assert.deepEqual(duplicateIds(doc), { a: 2 });
    const plan = planAdopt(doc);
    assert.deepEqual(plan.report.duplicated, [{ id: "a", copies: 2 }]);
    const after = apply(doc, plan.requests);
    const page = parseDocument(after);
    const [first, second] = ids(page);
    assert.equal(first, "a");
    assert.notEqual(second, "a");
    assert.deepEqual(duplicateIds(after), {});
    assert.deepEqual(planAdopt(after).requests, []);
  });

  test("the first section has a stable id, so snapshots of it compare", () => {
    const doc = docWith(["One"], { "pg/node/a": [span(0)] });
    assert.equal(parseDocument(doc).sections[0]!.id, FIRST_SECTION_ID);
    assert.equal(parseDocument(structuredClone(doc)).sections[0]!.id, FIRST_SECTION_ID);
  });
});

describe("adoptPage", () => {
  function client(initial: DocsDocument) {
    let doc = initial;
    const writes: object[][] = [];
    const google: GoogleClient = {
      listDocuments: async () => [],
      fetchDocument: async () => structuredClone(doc),
      createDocument: async () => doc,
      batchUpdate: async (_token, _fileId, requests) => {
        writes.push(requests);
        doc = apply(doc, requests);
        return {};
      },
    };
    return { google, writes };
  }
  const ctx = (google: GoogleClient) => ({ actor: { sub: "u", client: "api" as const }, googleToken: "tok", requestId: "r", google });

  test("writes once, then a second import of the same Doc makes no writes", async () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const { google, writes } = client(docWith(["One", "Two"], {}));
    const first = await adoptPage(ctx(google), "doc");
    assert.equal(first.wrote, true);
    assert.equal(first.report.adopted, 2);
    assert.equal(writes.length, 1);
    const second = await adoptPage(ctx(google), "doc");
    assert.equal(second.wrote, false);
    assert.equal(writes.length, 1);
    assert.deepEqual(ids(second.page), ids(first.page));
  });

  test("needs the commit scope", async () => {
    const { google } = client(docWith(["One"], {}));
    await assert.rejects(adoptPage({ ...ctx(google), scopes: new Set(["pages:read" as const]) }, "doc"), /pages:commit/);
  });
});
