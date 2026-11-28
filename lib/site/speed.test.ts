import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { parseSample, recordSample, setSpeedReport, speedReport, speedReportEnabled } from "./speed";
import { renderContextFor, siteForOwner } from "./theme-config";

describe("parseSample", () => {
  test("accepts a beacon body and rounds it", () => {
    assert.deepEqual(parseSample(JSON.stringify({ site: "s1", path: "/a/b", lcp: 1234.6, cls: 0.12345, inp: 90.2 })), {
      site: "s1",
      path: "/a/b",
      values: { lcp: 1235, cls: 0.123, inp: 90 },
    });
  });
  test("refuses bad shapes, paths, sites and out-of-range numbers", () => {
    for (const body of [
      "not json",
      "[]",
      { site: "s1", path: "a", lcp: 1 },
      { site: "s 1", path: "/a", lcp: 1 },
      { site: "s1", path: "/a" },
      { site: "s1", path: "/a", lcp: -1 },
      { site: "s1", path: "/a", cls: 99 },
      { site: "s1", path: "/a", inp: "1" },
      { site: "s1", path: "/a?x=1", lcp: 1 },
    ]) {
      assert.equal(parseSample(typeof body === "string" ? body : JSON.stringify(body)), null, JSON.stringify(body));
    }
  });
});

const url = testDatabaseUrl();
describe("field speed report (#70)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("samples are kept only while the report is on, and the report gives p75 per page", async () => {
    const siteId = await siteForOwner("speed-owner");
    const sample = (lcp: number) => ({ site: siteId, path: "/slow", values: { lcp } });
    assert.equal(await recordSample(sample(1000)), false, "off by default");
    await setSpeedReport(siteId, true);
    assert.equal(await speedReportEnabled(siteId), true);
    for (const lcp of [1000, 2000, 3000, 4000]) assert.equal(await recordSample(sample(lcp)), true);
    await recordSample({ site: siteId, path: "/fast", values: { lcp: 800, cls: 0.01, inp: 50 } });
    const report = await speedReport(siteId);
    assert.deepEqual(report.pages.map((page) => page.path), ["/slow", "/fast"], "worst page first");
    assert.equal(report.pages[0]!.metrics.lcp!.p75, 3250);
    assert.equal(report.pages[0]!.metrics.lcp!.good, false);
    assert.equal(report.pages[1]!.metrics.lcp!.good, true);
    assert.equal(report.pages[1]!.metrics.cls!.samples, 1);
  });

  test("old samples are dropped, and a site that turns it off ships no beacon", async () => {
    const siteId = await siteForOwner("speed-owner-2");
    await setSpeedReport(siteId, true);
    await recordSample({ site: siteId, path: "/x", values: { lcp: 900 } });
    await query("UPDATE vitals_samples SET created_at = now() - interval '40 days' WHERE site_id = $1", [siteId]);
    assert.equal((await speedReport(siteId)).pages.length, 0);

    process.env.APP_URL = "https://app.example.com";
    assert.equal((await renderContextFor("speed-owner-2", "doc")).beacon?.site, siteId);
    await setSpeedReport(siteId, false);
    assert.equal((await renderContextFor("speed-owner-2", "doc")).beacon, undefined);
    delete process.env.APP_URL;
  });
});
