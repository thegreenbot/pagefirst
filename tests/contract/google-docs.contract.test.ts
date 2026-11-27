/**
 * Contract test against the real Google Docs and Drive APIs.
 *
 * It runs only when TEST_GOOGLE_CLIENT_ID, TEST_GOOGLE_CLIENT_SECRET and
 * TEST_GOOGLE_REFRESH_TOKEN are set (see .github/workflows/google-contract.yml).
 * It creates a throwaway Doc, drives it through the same code the app uses to
 * read, adopt and commit, then deletes it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { batchUpdate, createDocument, fetchDocument, listDocuments } from "@/lib/google/docs";
import { buildAdoptRequests, buildCommitRequests } from "@/lib/google/commit";
import { parseDocument } from "@/lib/page/parse";
import type { DocsDocument, Page, Prose } from "@/lib/page/types";

const clientId = process.env.TEST_GOOGLE_CLIENT_ID;
const clientSecret = process.env.TEST_GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.TEST_GOOGLE_REFRESH_TOKEN;
const configured = Boolean(clientId && clientSecret && refreshToken);

async function exchangeRefreshToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId!,
      client_secret: clientSecret!,
      refresh_token: refreshToken!,
      grant_type: "refresh_token",
    }),
  });
  // Never print the body: it can echo credentials back.
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Token exchange returned no access token");
  return json.access_token;
}

async function deleteFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed (${res.status})`);
}

function proseNodes(page: Page): Prose[] {
  return page.sections.flatMap((section) =>
    section.children.filter((node): node is Prose => node.kind === "prose"),
  );
}

function bodyText(doc: DocsDocument): string {
  let text = "";
  for (const el of doc.body?.content ?? []) {
    for (const run of el.paragraph?.elements ?? []) text += run.textRun?.content ?? "";
  }
  return text;
}

describe("Google Docs contract", { skip: configured ? false : "TEST_GOOGLE_* secrets not set" }, () => {
  let token = "";
  let fileId = "";

  before(async () => {
    token = await exchangeRefreshToken();
  });

  after(async () => {
    if (token && fileId) await deleteFile(token, fileId);
  });

  test("creates a Doc the app can read", async () => {
    const created = await createDocument(token, `pagefirst contract ${new Date().toISOString()}`);
    assert.ok(created.documentId, "createDocument returns a documentId");
    fileId = created.documentId!;

    await batchUpdate(token, fileId, [
      { insertText: { text: "Contract heading\nFirst paragraph\n", location: { index: 1 } } },
      {
        updateParagraphStyle: {
          range: { startIndex: 1, endIndex: 17 },
          paragraphStyle: { namedStyleType: "HEADING_1" },
          fields: "namedStyleType",
        },
      },
    ]);

    const doc = await fetchDocument(token, fileId);
    assert.ok(doc.revisionId, "documents.get returns a revisionId");
    const page = parseDocument(doc, "contract");
    const texts = proseNodes(page).map((node) => [node.tag, node.text]);
    assert.deepEqual(texts.slice(0, 2), [
      ["h1", "Contract heading"],
      ["p", "First paragraph"],
    ]);
  });

  test("lists the new Doc through Drive", async () => {
    assert.ok(fileId, "needs the Doc from the previous test");
    let found = false;
    for (let attempt = 0; attempt < 5 && !found; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
      found = (await listDocuments(token)).some((file) => file.id === fileId);
    }
    assert.ok(found, "listDocuments includes the Doc created by this client");
  });

  test("adopts named ranges, commits edits, and changes the revision", async () => {
    assert.ok(fileId, "needs the Doc from the first test");
    let doc = await fetchDocument(token, fileId);
    const baseRevision = doc.revisionId;
    const [heading, paragraph] = proseNodes(parseDocument(doc, "contract"));

    // A fresh Doc has no pg/node ranges, so the commit must fail and be adopted,
    // exactly as lib/store.ts commitLive does.
    const ops = [{ op: "replaceText" as const, nodeId: heading.id, text: "Edited heading" }];
    assert.throws(() => buildCommitRequests(doc, ops), /Missing named range/);
    const adopt = buildAdoptRequests(doc).requests;
    assert.ok(adopt.length >= 2, "adopt creates a named range per node");
    await batchUpdate(token, fileId, adopt);

    doc = await fetchDocument(token, fileId);
    const adopted = proseNodes(parseDocument(doc, "contract"));
    assert.equal(adopted[0].id, heading.id, "node ids survive adoption");
    assert.equal(adopted[1].id, paragraph.id);

    await batchUpdate(
      token,
      fileId,
      buildCommitRequests(doc, [
        ...ops,
        { op: "replaceText", nodeId: paragraph.id, text: "Edited paragraph, longer than before" },
      ]).requests,
    );

    const updated = await fetchDocument(token, fileId);
    assert.notEqual(updated.revisionId, baseRevision, "a write changes revisionId (the 409 check relies on this)");
    // A new Doc starts with one empty paragraph, which stays after our inserted text.
    assert.equal(bodyText(updated), "Edited heading\nEdited paragraph, longer than before\n\n");
    const nodes = proseNodes(parseDocument(updated, "contract"));
    assert.deepEqual(
      nodes.slice(0, 2).map((node) => [node.id, node.tag, node.text]),
      [
        [heading.id, "h1", "Edited heading"],
        [paragraph.id, "p", "Edited paragraph, longer than before"],
      ],
    );

    // A second commit on the same ids must work without re-adopting.
    await batchUpdate(
      token,
      fileId,
      buildCommitRequests(updated, [{ op: "replaceText", nodeId: paragraph.id, text: "Short" }]).requests,
    );
    const again = await fetchDocument(token, fileId);
    assert.equal(bodyText(again), "Edited heading\nShort\n\n");
    assert.deepEqual(
      proseNodes(parseDocument(again, "contract"))
        .slice(0, 2)
        .map((node) => node.id),
      [heading.id, paragraph.id],
    );
  });

  test("rejects a stale revision the way commitLive does", async () => {
    assert.ok(fileId, "needs the Doc from the first test");
    const first = await fetchDocument(token, fileId);
    await batchUpdate(token, fileId, [{ insertText: { text: "x", location: { index: 1 } } }]);
    const second = await fetchDocument(token, fileId);
    // commitLive returns 409 when the current revisionId differs from the client's base.
    assert.ok(first.revisionId && second.revisionId);
    assert.notEqual(second.revisionId, first.revisionId);
  });
});
