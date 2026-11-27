import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import type { DocsDocument, Op } from "@/lib/page/types";
import { commit, createPage, getPage, listPages, publish, resetSamplePages, ServiceError, SCOPES, type GoogleClient, type Scope, type ServiceContext } from "./index";

function ctx(overrides: Partial<ServiceContext> = {}): ServiceContext {
  return { actor: { sub: null, client: "api" }, googleToken: null, requestId: "req-1", ...overrides };
}

const only = (...scopes: Scope[]) => new Set<Scope>(scopes);

function helloDoc(revisionId: string): DocsDocument {
  return {
    documentId: "doc1",
    revisionId,
    title: "Hello",
    body: { content: [{ startIndex: 1, endIndex: 7, paragraph: { elements: [{ textRun: { content: "Hello\n" } }] } }] },
    namedRanges: { "pg/node/abc": { name: "pg/node/abc", namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 6 }] }] } },
  };
}

function fakeGoogle(overrides: Partial<GoogleClient> = {}): GoogleClient & { writes: object[][] } {
  const writes: object[][] = [];
  return {
    writes,
    listDocuments: async () => [{ id: "doc1", name: "Hello World" }],
    fetchDocument: async () => helloDoc("rev1"),
    createDocument: async (_token, title) => ({ ...helloDoc("rev1"), title }),
    batchUpdate: async (_token, _fileId, requests) => {
      writes.push(requests);
      return {};
    },
    ...overrides,
  };
}

const savedId = process.env.GOOGLE_CLIENT_ID;
const savedSecret = process.env.GOOGLE_CLIENT_SECRET;
beforeEach(() => {
  resetSamplePages();
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
});
afterEach(() => {
  if (savedId === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = savedId;
  if (savedSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = savedSecret;
});

const replace: Op[] = [{ op: "replaceText", nodeId: "abc", text: "Hi" }];

test("no module under lib/service imports next/*", () => {
  const dir = join(process.cwd(), "lib", "service");
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    assert.doesNotMatch(readFileSync(join(dir, name), "utf8"), /from "next\//, `${name} imports next`);
  }
});

test("lists, reads and creates through the supplied Google client", async () => {
  const google = fakeGoogle();
  const live = ctx({ googleToken: "tok", google });
  const library = await listPages(live);
  assert.equal(library.sample, false);
  assert.equal(library.pages[0]?.path, "hello-world");
  const payload = await getPage(live, "doc1");
  assert.equal(payload?.page.revisionId, "rev1");
  const created = await createPage(live, "Fresh");
  assert.equal(created.sample, false);
});

test("a Google 404 reads as a missing page, a 403 as forbidden", async () => {
  const missing = ctx({ googleToken: "tok", google: fakeGoogle({ fetchDocument: async () => { throw new Error("Docs read failed (404)"); } }) });
  assert.equal(await getPage(missing, "gone"), null);
  const denied = ctx({ googleToken: "tok", google: fakeGoogle({ fetchDocument: async () => { throw new Error("Docs read failed (403)"); } }) });
  await assert.rejects(getPage(denied, "locked"), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
});

test("commit applies ops and refuses a stale revision with a typed conflict", async () => {
  const google = fakeGoogle();
  const live = ctx({ googleToken: "tok", google });
  const ok = await commit(live, "doc1", "rev1", replace);
  assert.equal(ok.ok, true);
  assert.ok(google.writes.length > 0);

  const stale = await commit(live, "doc1", "old", replace);
  assert.equal(stale.ok, false);
  if (!stale.ok) {
    assert.equal(stale.status, 409);
    assert.equal(stale.code, "conflict");
    assert.ok(stale.page);
  }
});

test("a Google quota response becomes upstream_quota, other failures 502, tokens are redacted", async () => {
  const quota = ctx({ googleToken: "tok", google: fakeGoogle({ batchUpdate: async () => { throw new Error("Docs write failed (429)"); } }) });
  const limited = await commit(quota, "doc1", "rev1", replace);
  assert.equal(limited.ok, false);
  if (!limited.ok) assert.deepEqual([limited.status, limited.code], [429, "upstream_quota"]);

  const broken = ctx({ googleToken: "tok-secret-123", google: fakeGoogle({ batchUpdate: async () => { throw new Error("boom tok-secret-123"); } }) });
  const failed = await commit(broken, "doc1", "rev1", replace);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.status, 502);
    assert.doesNotMatch(failed.error, /tok-secret-123/);
  }
});

test("sample mode works with no token and no Google calls", async () => {
  const library = await listPages(ctx());
  assert.equal(library.sample, true);
  const about = library.pages[0]!;
  const payload = await getPage(ctx(), about.fileId);
  assert.ok(payload);
  assert.equal(await getPage(ctx(), "nope"), null);
  const stale = await commit(ctx(), about.fileId, "wrong", []);
  assert.equal(stale.ok, false);
});

test("a read-only key cannot commit, create or publish publicly", async () => {
  const google = fakeGoogle();
  const reader = ctx({ googleToken: "tok", google, scopes: only("pages:read") });
  assert.equal((await listPages(reader)).sample, false);
  const forbidden = (err: unknown) => err instanceof ServiceError && err.code === "forbidden" && err.status === 403;
  await assert.rejects(commit(reader, "doc1", "rev1", replace), forbidden);
  await assert.rejects(createPage(reader, "x"), forbidden);
  await assert.rejects(publish(reader, "doc1", { public: true }), forbidden);
  assert.equal(google.writes.length, 0);
});

test("publish scope is separate from commit scope", async () => {
  const committer = ctx({ googleToken: "tok", google: fakeGoogle(), scopes: only("pages:read", "pages:commit") });
  await assert.rejects(publish(committer, "doc1", { public: true }), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
  const nothing = ctx({ scopes: new Set<Scope>() });
  await assert.rejects(listPages(nothing), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
  assert.deepEqual([...SCOPES], ["pages:read", "pages:commit", "pages:import", "pages:publish"]);
});

test("publish refuses a stale revisionId", async () => {
  const live = ctx({ googleToken: "tok", google: fakeGoogle() });
  await assert.rejects(publish(live, "doc1", { revisionId: "older" }), (err: unknown) => err instanceof ServiceError && err.code === "conflict");
});

test("a site-folder allow-list lists only those folders and hides other pages", async () => {
  let listedWith: readonly string[] | undefined;
  const google = fakeGoogle({
    listDocuments: async (_token, folders) => {
      listedWith = folders;
      return [];
    },
    parentsOf: async (_token, fileId) => (fileId === "inside" ? ["folderA"] : ["elsewhere"]),
  });
  const keyed = ctx({ googleToken: "tok", google, siteFolders: ["folderA"], scopes: only("pages:read", "pages:commit") });
  await listPages(keyed);
  assert.deepEqual(listedWith, ["folderA"]);
  assert.ok(await getPage(keyed, "inside"));
  // Outside the folder looks exactly like a missing page.
  assert.equal(await getPage(keyed, "outside"), null);
  const refused = await commit(keyed, "outside", "rev1", replace);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, "not_found");
  assert.equal(google.writes.length, 0);
  const allowed = await commit(keyed, "inside", "rev1", replace);
  assert.equal(allowed.ok, true);
});

test("a site-folder allow-list fails closed without a folder lookup, and cannot create pages", async () => {
  const keyed = ctx({ googleToken: "tok", google: fakeGoogle(), siteFolders: ["folderA"] });
  await assert.rejects(getPage(keyed, "doc1"), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
  await assert.rejects(createPage(keyed, "x"), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
  await assert.rejects(publish(keyed, "doc1"), (err: unknown) => err instanceof ServiceError && err.code === "forbidden");
});
