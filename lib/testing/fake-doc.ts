import type { DocsDocument } from "@/lib/page/types";
import type { GoogleClient } from "@/lib/service";

/** A Google Doc held in memory, with the named-range and edit operations the import tests need. Test support only. */
type Range = { startIndex: number; endIndex: number };

export function makeDoc(texts: string[], named: boolean): DocsDocument {
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

export function fake(initial: DocsDocument) {
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

