import assert from "node:assert/strict";
import test from "node:test";
import { buildCommitRequests } from "./commit";
import type { DocsDocument, Op } from "@/lib/page/types";

function helloDoc(): DocsDocument {
  return {
    title: "Hello",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 7,
          paragraph: {
            elements: [{ textRun: { content: "Hello\n" } }],
          },
        },
      ],
    },
    namedRanges: {
      "pg/node/abc": {
        name: "pg/node/abc",
        namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 6 }] }],
      },
    },
  };
}

test("replaceText deletes through the character before the newline and inserts at the start", () => {
  const ops: Op[] = [{ op: "replaceText", nodeId: "abc", text: "Hi" }];
  const { requests } = buildCommitRequests(helloDoc(), ops);
  assert.deepEqual(requests, [
    {
      deleteContentRange: {
        range: { startIndex: 1, endIndex: 5 },
      },
    },
    {
      insertText: {
        text: "Hi",
        location: { index: 1 },
      },
    },
    { deleteNamedRange: { name: "pg/node/abc" } },
    {
      createNamedRange: {
        name: "pg/node/abc",
        range: { startIndex: 1, endIndex: 4 },
      },
    },
  ]);
});

test("replaceText re-creates the node's named range over the new text", () => {
  const ops: Op[] = [{ op: "replaceText", nodeId: "abc", text: "Hello there" }];
  const { requests } = buildCommitRequests(helloDoc(), ops);
  assert.deepEqual(requests.slice(-1), [
    {
      createNamedRange: {
        name: "pg/node/abc",
        range: { startIndex: 1, endIndex: 13 },
      },
    },
  ]);
});

test("setTag is not a live commit", () => {
  const ops: Op[] = [{ op: "setTag", nodeId: "abc", tag: "h1" }];
  assert.throws(() => buildCommitRequests(helloDoc(), ops), /Live commit does not support setTag/);
});

test("replaceText finds a named range by its name when the key differs", () => {
  const doc = helloDoc();
  doc.namedRanges = {
    "kix.abc": {
      name: "pg/node/abc",
      namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 6 }] }],
    },
  };
  const { requests } = buildCommitRequests(doc, [{ op: "replaceText", nodeId: "abc", text: "Hi" }]);
  assert.equal(
    (requests[1] as { insertText: { text: string } }).insertText.text,
    "Hi",
  );
});

test("writes the higher index first so earlier ranges stay valid", () => {
  const doc = helloDoc();
  doc.namedRanges = {
    "pg/node/low": {
      namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 6 }] }],
    },
    "pg/node/high": {
      namedRanges: [{ ranges: [{ startIndex: 20, endIndex: 28 }] }],
    },
  };
  const { requests } = buildCommitRequests(doc, [
    { op: "replaceText", nodeId: "low", text: "A" },
    { op: "replaceText", nodeId: "high", text: "B" },
  ]);
  assert.equal(
    (requests[0] as { deleteContentRange: { range: { startIndex: number } } }).deleteContentRange.range
      .startIndex,
    20,
  );
  assert.equal(
    (requests[4] as { deleteContentRange: { range: { startIndex: number } } }).deleteContentRange.range
      .startIndex,
    1,
  );
});

test("replaceText requires the node named range", () => {
  const ops: Op[] = [{ op: "replaceText", nodeId: "missing", text: "Hi" }];
  assert.throws(() => buildCommitRequests(helloDoc(), ops), /Missing named range for missing/);
});

test("setMetadata rewrites the value cell and refuses deletion", () => {
  const doc: DocsDocument = {
    body: {
      content: [
        {
          table: {
            rows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        startIndex: 2,
                        endIndex: 12,
                        paragraph: { elements: [{ textRun: { content: "Metadata\n" } }] },
                      },
                    ],
                  },
                ],
              },
              {
                tableCells: [
                  {
                    content: [
                      {
                        startIndex: 14,
                        endIndex: 21,
                        paragraph: { elements: [{ textRun: { content: "title\n" } }] },
                      },
                    ],
                  },
                  {
                    content: [
                      {
                        startIndex: 23,
                        endIndex: 30,
                        paragraph: { elements: [{ textRun: { content: "About\n" } }] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  };
  const { requests } = buildCommitRequests(doc, [{ op: "setMetadata", key: "title", value: "Studio" }]);
  assert.deepEqual(requests, [
    {
      deleteContentRange: {
        range: { startIndex: 23, endIndex: 29 },
      },
    },
    {
      insertText: {
        text: "Studio",
        location: { index: 23 },
      },
    },
  ]);
  assert.throws(
    () => buildCommitRequests(doc, [{ op: "setMetadata", key: "title", value: "" }]),
    /Live commit cannot delete metadata keys/,
  );
  assert.throws(
    () => buildCommitRequests(doc, [{ op: "setMetadata", key: "missing", value: "x" }]),
    /Metadata key not found: missing/,
  );
});
