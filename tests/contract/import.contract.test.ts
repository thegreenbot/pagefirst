/**
 * Contract test for the import flow against the real Google Docs and Drive APIs
 * (#32, #34, #42). Same secrets and throwaway-Doc approach as
 * google-docs.contract.test.ts. It checks the Docs behaviour the import code
 * assumes: how named ranges survive pasted text, edits, merged paragraphs and
 * copied ranges, that adopt converges, and what Drive says about the last edit.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { batchUpdate, createDocument, driveMeta, fetchDocument } from "@/lib/google/docs";
import { planAdopt } from "@/lib/google/adopt";
import { countSuggestions } from "@/lib/google/suggestions";
import { diffPages } from "@/lib/page/diff";
import { duplicateIds, parseDocument } from "@/lib/page/parse";
import type { DocsDocument, Page } from "@/lib/page/types";

const clientId = process.env.TEST_GOOGLE_CLIENT_ID;
const clientSecret = process.env.TEST_GOOGLE_CLIENT_SECRET;
const refreshToken = process.env.TEST_GOOGLE_REFRESH_TOKEN;
const configured = Boolean(clientId && clientSecret && refreshToken);

async function exchangeRefreshToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId!, client_secret: clientSecret!, refresh_token: refreshToken!, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Token exchange returned no access token");
  return json.access_token;
}

async function deleteFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed (${res.status})`);
}

const ids = (page: Page) => page.sections.flatMap((section) => section.children.map((node) => node.id));

/** The index span of the paragraph whose text starts with `prefix`. */
function paragraphSpan(doc: DocsDocument, prefix: string): { startIndex: number; endIndex: number } {
  for (const el of doc.body?.content ?? []) {
    const text = (el.paragraph?.elements ?? []).map((part) => part.textRun?.content ?? "").join("");
    if (text.startsWith(prefix) && typeof el.startIndex === "number" && typeof el.endIndex === "number") return { startIndex: el.startIndex, endIndex: el.endIndex };
  }
  throw new Error(`No paragraph starting with "${prefix}"`);
}

describe("Import flow against real Google Docs", { skip: configured ? false : "TEST_GOOGLE_* secrets not set" }, () => {
  let token = "";
  let fileId = "";

  before(async () => {
    token = await exchangeRefreshToken();
    const created = await createDocument(token, `pagefirst import contract ${new Date().toISOString()}`);
    fileId = created.documentId!;
    // Text pasted into Docs has no named ranges.
    await batchUpdate(token, fileId, [
      { insertText: { text: "Import title\nPasted one stays\nPasted two stays\nPasted three stays\n", location: { index: 1 } } },
      { updateParagraphStyle: { range: { startIndex: 1, endIndex: 13 }, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } },
    ]);
  });

  after(async () => {
    if (token && fileId) await deleteFile(token, fileId);
  });

  test("adopt tracks pasted content, ids hold across fetches, and a second adopt writes nothing", async () => {
    const doc = await fetchDocument(token, fileId);
    const plan = planAdopt(doc);
    assert.ok(plan.requests.length >= 4, "one named range per untracked paragraph");
    await batchUpdate(token, fileId, plan.requests);

    const adopted = await fetchDocument(token, fileId);
    assert.deepEqual(planAdopt(adopted).requests, [], "a second import makes no Doc writes");
    const again = await fetchDocument(token, fileId);
    assert.deepEqual(ids(parseDocument(adopted)), ids(parseDocument(again)), "ids come from the Doc, not from the parse");
    assert.equal(new Set(ids(parseDocument(adopted))).size, ids(parseDocument(adopted)).length);
  });

  test("an edit made in Google Docs diffs as a text change on the same node", async () => {
    const before = await fetchDocument(token, fileId);
    const beforePage = parseDocument(before);
    const span = paragraphSpan(before, "Pasted one");
    // Inside the paragraph, so the named range grows to hold the new text.
    await batchUpdate(token, fileId, [{ insertText: { text: " and edited", location: { index: span.startIndex + 6 } } }]);
    const after = await fetchDocument(token, fileId);
    const changes = diffPages(beforePage, parseDocument(after));
    assert.deepEqual(changes.map((change) => change.kind), ["prose.text"], JSON.stringify(changes.map((change) => change.kind)));
    assert.notEqual(after.revisionId, before.revisionId);
    assert.equal(planAdopt(after).requests.length, 0, "an edit inside a range leaves the Doc fully tracked");
  });

  test("Drive reports the last modified time, and moves it forward on an edit", async () => {
    const first = await driveMeta(token, fileId);
    assert.ok(first.modifiedTime, "files.get returns modifiedTime");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const span = paragraphSpan(await fetchDocument(token, fileId), "Pasted two");
    await batchUpdate(token, fileId, [{ insertText: { text: "!", location: { index: span.startIndex + 4 } } }]);
    const second = await driveMeta(token, fileId);
    assert.ok(Date.parse(second.modifiedTime!) > Date.parse(first.modifiedTime!));
    // Whether drive.file returns the last editor is what ADR 0006 asks to learn; report it.
    console.log(`lastModifyingUser present: ${second.lastModifiedBy !== null}`);
  });

  test("merging two paragraphs in Docs still converges: unique ids, one adopt, then no writes", async () => {
    const doc = await fetchDocument(token, fileId);
    const one = paragraphSpan(doc, "Pasted one");
    // Delete the newline between "Pasted one..." and the next paragraph.
    await batchUpdate(token, fileId, [{ deleteContentRange: { range: { startIndex: one.endIndex - 1, endIndex: one.endIndex } } }]);
    const merged = await fetchDocument(token, fileId);
    const page = parseDocument(merged);
    assert.equal(new Set(ids(page)).size, ids(page).length, "no two nodes share an id");
    const plan = planAdopt(merged);
    if (plan.requests.length > 0) await batchUpdate(token, fileId, plan.requests);
    const settled = await fetchDocument(token, fileId);
    assert.deepEqual(planAdopt(settled).requests, [], "adopt converges");
    assert.equal(new Set(ids(parseDocument(settled))).size, ids(parseDocument(settled)).length);
  });

  test("a range copied onto a second paragraph is split: the first keeps the id, the copy gets a new one", async () => {
    let doc = await fetchDocument(token, fileId);
    const a = paragraphSpan(doc, "Pasted three");
    const b = paragraphSpan(doc, "Import title");
    await batchUpdate(token, fileId, [
      { createNamedRange: { name: "pg/node/copydup", range: { startIndex: b.startIndex, endIndex: b.endIndex - 1 } } },
      { createNamedRange: { name: "pg/node/copydup", range: { startIndex: a.startIndex, endIndex: a.endIndex - 1 } } },
    ]);
    doc = await fetchDocument(token, fileId);
    const claimed = duplicateIds(doc);
    assert.equal(claimed.copydup, 2, "two nodes claim the same id");
    const plan = planAdopt(doc);
    assert.deepEqual(plan.report.duplicated, [{ id: "copydup", copies: 2 }]);
    await batchUpdate(token, fileId, plan.requests);
    const settled = await fetchDocument(token, fileId);
    assert.deepEqual(duplicateIds(settled), {});
    assert.deepEqual(planAdopt(settled).requests, []);
    const all = ids(parseDocument(settled));
    assert.equal(new Set(all).size, all.length);
    assert.equal(all.filter((id) => id === "copydup").length, 1, "exactly one node keeps the id");
  });

  test("a Doc with no suggestions reports none", async () => {
    // The API cannot create suggested edits, so only the absence is checked here.
    assert.equal(countSuggestions(await fetchDocument(token, fileId)), 0);
  });
});
