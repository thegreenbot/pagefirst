import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { DocsDocument } from "@/lib/page/types";
import { contentAudit, resetSamplePages, ServiceError, type GoogleClient, type Scope, type ServiceContext } from "./index";

function doc(id: string, title: string, text: string): DocsDocument {
  return {
    documentId: id,
    revisionId: `${id}-rev`,
    title,
    body: { content: [{ startIndex: 1, endIndex: text.length + 1, paragraph: { elements: [{ textRun: { content: `${text}\n` } }] } }] },
    namedRanges: { "pg/node/n1": { name: "pg/node/n1", namedRanges: [{ ranges: [{ startIndex: 1, endIndex: text.length + 1 }] }] } },
  };
}

const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 41}`).join(" ");
const docs: Record<string, DocsDocument> = {
  a: doc("a", "Pricing", words(160, "price")),
  b: doc("b", "Pricing copy", words(160, "price")),
  c: doc("c", "Stub", "Coming soon."),
};

const google: GoogleClient = {
  listDocuments: async () => [
    { id: "a", name: "Pricing", modifiedTime: "2020-01-01T00:00:00Z" },
    { id: "b", name: "Pricing copy", modifiedTime: "2026-05-01T00:00:00Z" },
    { id: "c", name: "Stub", modifiedTime: "2026-05-30T00:00:00Z" },
  ],
  fetchDocument: async (_t, id) => docs[id]!,
  createDocument: async () => docs.a!,
  batchUpdate: async () => ({}),
};

const ctx = (scopes?: Set<Scope>): ServiceContext => ({ actor: { sub: "s", client: "api" }, googleToken: "tok", requestId: "r", google, scopes });

const saved = [process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET];
beforeEach(() => {
  resetSamplePages();
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
});
afterEach(() => {
  for (const [i, key] of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].entries()) {
    if (saved[i] === undefined) delete process.env[key];
    else process.env[key] = saved[i];
  }
});

test("a live audit flags the stale, thin and duplicate pages", async () => {
  const report = await contentAudit(ctx(), { now: new Date("2026-06-01T00:00:00Z") });
  assert.equal(report.pagesChecked, 3);
  assert.equal(report.sample, false);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.stale.map((s) => s.fileId), ["a"]);
  assert.deepEqual(report.thin.map((t) => t.fileId), ["c"]);
  assert.deepEqual(report.duplicates[0]?.pages.map((p) => p.fileId).sort(), ["a", "b"]);
});

test("thresholds from the request are applied", async () => {
  const report = await contentAudit(ctx(), { now: new Date("2026-06-01T00:00:00Z"), thinWords: 1, staleDays: 5000 });
  assert.deepEqual(report.thin, []);
  assert.deepEqual(report.stale, []);
});

test("a credential without pages:read is refused", async () => {
  await assert.rejects(contentAudit(ctx(new Set<Scope>(["pages:commit"]))), (e) => e instanceof ServiceError && e.code === "forbidden");
});

test("sample mode audits the sample pages", async () => {
  const report = await contentAudit({ actor: { sub: null, client: "api" }, googleToken: null, requestId: "r" });
  assert.equal(report.sample, true);
  assert.ok(report.pagesChecked >= 1);
});
