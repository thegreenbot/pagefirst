import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { MAX_CONCURRENT_JOBS_PER_CREDENTIAL, MAX_PAGES_PER_JOB } from "@/lib/api/limits";
import { claimItems, createJob, finishItem, getJob, jobCounts, listItems, requestCancel, resumeJob, settleJob, STALE_ITEM_MS } from "./store";
import { buildReport, csvCell, reportCsv } from "./report";

const url = testDatabaseUrl();

const base = (credentialId: string, n: number) => ({
  credentialId,
  sub: "u1",
  scopes: ["pages:commit" as const],
  siteFolders: undefined,
  kind: "commit" as const,
  dryRun: false,
  policy: {},
  items: Array.from({ length: n }, (_, i) => ({ fileId: `file${i}`, params: {} })),
});

describe("job report CSV", () => {
  test("defuses spreadsheet formulas and quotes separators", () => {
    assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
    assert.equal(csvCell("-1+1"), "'-1+1");
    assert.equal(csvCell('a,"b"'), '"a,""b"""');
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(7), "7");
  });
});

describe("jobs in Postgres", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("a 200-page job is claimed in order, finishes, and reports per item", async () => {
    const job = await createJob(base("c-big", 200));
    let seen = 0;
    for (;;) {
      const batch = await claimItems(job.id, 25);
      if (batch.length === 0) break;
      for (const item of batch) {
        await finishItem(job.id, item.idx, item.idx % 50 === 0 ? "conflict" : "ok", item.idx % 50 === 0 ? { code: "revision_conflict", message: "=bad" } : {});
        seen += 1;
      }
    }
    assert.equal(seen, 200);
    assert.equal(await settleJob(job.id), "done");
    const counts = await jobCounts(job.id);
    assert.equal(counts.ok, 196);
    assert.equal(counts.conflict, 4);
    const row = (await getJob(job.id, "c-big"))!;
    const report = buildReport(row, counts, await listItems(job.id, -1, 500));
    assert.equal(report.items.length, 200);
    assert.ok(reportCsv(report).includes("'=bad"));
  });

  test("another credential cannot see, cancel or resume the job", async () => {
    const job = await createJob(base("c-owner", 2));
    assert.equal(await getJob(job.id, "c-other"), null);
    assert.equal(await requestCancel(job.id, "c-other"), null);
    assert.equal(await resumeJob(job.id, "c-other"), null);
  });

  test("a job survives a restart: a stale running item is handed out again", async () => {
    const job = await createJob(base("c-restart", 3));
    const first = await claimItems(job.id, 3);
    assert.equal(first.length, 3);
    assert.equal((await claimItems(job.id, 3)).length, 0);
    // The process died mid-run; later the items are stale and get reclaimed.
    const later = new Date(Date.now() + STALE_ITEM_MS + 1000);
    const again = await claimItems(job.id, 3, later);
    assert.equal(again.length, 3);
    assert.ok(again.every((item) => item.attempts === 2));
  });

  test("concurrent claims never hand out the same item twice", async () => {
    const job = await createJob(base("c-race", 20));
    const batches = await Promise.all(Array.from({ length: 6 }, () => claimItems(job.id, 5)));
    const idxs = batches.flat().map((item) => item.idx);
    assert.equal(new Set(idxs).size, idxs.length);
    assert.equal(idxs.length, 20);
  });

  test("cancel stops new work and settles as cancelled", async () => {
    const job = await createJob(base("c-cancel", 4));
    const [first] = await claimItems(job.id, 1);
    await requestCancel(job.id, "c-cancel");
    await finishItem(job.id, first!.idx, "ok");
    assert.equal(await settleJob(job.id), "cancelled");
    const counts = await jobCounts(job.id);
    assert.equal(counts.ok, 1);
    assert.equal(counts.cancelled, 3);
  });

  test("caps the items per job and the active jobs per credential", async () => {
    await assert.rejects(createJob(base("c-cap", MAX_PAGES_PER_JOB + 1)), /at most/i);
    for (let i = 0; i < MAX_CONCURRENT_JOBS_PER_CREDENTIAL; i++) await createJob(base("c-conc", 1));
    await assert.rejects(createJob(base("c-conc", 1)), /at once/);
    assert.equal((await query("SELECT 1 FROM jobs WHERE credential_id = 'c-conc'")).length, MAX_CONCURRENT_JOBS_PER_CREDENTIAL);
  });
});
