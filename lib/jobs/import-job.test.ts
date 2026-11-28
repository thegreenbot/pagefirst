import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { baseSnapshot } from "@/lib/snapshots/store";
import { fake, makeDoc } from "@/lib/testing/fake-doc";
import type { ServiceContext } from "@/lib/service";
import { runImportItem } from "./run";
import type { JobItem, JobRow } from "./store";

const url = testDatabaseUrl();

const job = (over: Partial<JobRow> = {}): JobRow =>
  ({ id: "job-1", kind: "import", dryRun: true, policy: {}, sub: "u1", scopes: ["pages:import"], createdAt: "", startedAt: null, finishedAt: null, ...over }) as unknown as JobRow;
const item = (params: Record<string, unknown> = {}): JobItem => ({ idx: 0, fileId: "doc1", params, status: "running", code: null, message: null, result: null, attempts: 1 });

describe("import jobs", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
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

  const ctx = (f: ReturnType<typeof fake>): ServiceContext => ({ actor: { sub: "u1", client: "api" }, googleToken: "tok", requestId: "r", google: f.google });
  type Ok = { status: string; code?: string; result?: { revisionId: string; importId: string; changeCount: number; changeKinds: Record<string, number>; docAuthor: string } };

  test("a dry run reports the change list and the reviewed revision, and writes nothing", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    const out = (await runImportItem(job(), item(), ctx(f))) as Ok;
    assert.equal(out.status, "ok");
    assert.equal(out.result?.revisionId, f.doc.revisionId);
    assert.ok((out.result?.changeCount ?? 0) > 0);
    assert.equal(f.writes.length, 0);
    assert.equal(await baseSnapshot("doc1"), null);
    const audit = await query<{ job_id: string; import_id: string; error_code: string }>("SELECT job_id, import_id, error_code FROM audit_events WHERE import_id = $1", [out.result!.importId]);
    assert.deepEqual(audit.map((row) => [row.job_id, row.error_code]), [["job-1", "dry_run"]]);
  });

  test("the approved run, pinned to the reviewed revision, imports and links its audit entry to the job", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    const review = (await runImportItem(job(), item(), ctx(f))) as Ok;
    const run = (await runImportItem(job({ dryRun: false }), item({ revisionId: review.result!.revisionId }), ctx(f))) as Ok;
    assert.equal(run.status, "ok");
    assert.equal((await baseSnapshot("doc1"))?.importId, run.result?.importId);
    const audit = await query<{ job_id: string; import_id: string }>("SELECT job_id, import_id FROM audit_events WHERE import_id = $1", [run.result!.importId]);
    assert.deepEqual(audit.map((row) => [row.job_id, row.import_id]), [["job-1", run.result!.importId]]);
  });

  test("a Doc that moved since the review is skipped as revision_moved, with no writes", async () => {
    const f = fake(makeDoc(["Title", "Body"], false));
    const review = (await runImportItem(job(), item(), ctx(f))) as Ok;
    f.edit(1, "Edited after review");
    const run = (await runImportItem(job({ dryRun: false }), item({ revisionId: review.result!.revisionId }), ctx(f))) as Ok;
    assert.equal(run.status, "skipped");
    assert.equal(run.code, "revision_moved");
    assert.equal(f.writes.length, 0);
    assert.equal(await baseSnapshot("doc1"), null);
  });

  test("import_and_publish publishes the revision it imported, and records both steps against the job", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    const run = (await runImportItem(job({ kind: "import_and_publish", dryRun: false }), item({ public: false }), ctx(f))) as Ok;
    assert.equal(run.status, "ok");
    const audit = await query<{ event: string; job_id: string; import_id: string }>("SELECT event, job_id, import_id FROM audit_events WHERE import_id = $1 ORDER BY id", [run.result!.importId]);
    assert.deepEqual(audit.map((row) => row.event), ["page.import", "page.publish"]);
    assert.ok(audit.every((row) => row.job_id === "job-1" && row.import_id === run.result!.importId));
  });

  test("a Doc with pending suggestions is held back from publishing", async () => {
    const f = fake(makeDoc(["Title", "Body"], true));
    f.suggest();
    const run = (await runImportItem(job({ kind: "import_and_publish", dryRun: false }), item({ public: true }), ctx(f))) as Ok;
    assert.equal(run.status, "conflict");
    assert.equal(run.code, "suggestions_pending");
  });
});
