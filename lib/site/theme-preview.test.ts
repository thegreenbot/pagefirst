import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import type { Page } from "@/lib/page/types";
import { readPreview } from "@/lib/publish/preview";
import { readSiteTheme, savePresentation, siteForOwner, updateSiteTheme } from "./theme-config";
import { applyChange, discardChange, listSitePages, previewChange, readChangePreview, recordSitePage } from "./theme-preview";

const url = testDatabaseUrl();

function pages(): Map<string, Page> {
  const about = aboutFixture();
  const second = { ...aboutFixture(), fileId: "second", path: "second" };
  return new Map([
    [about.fileId, about],
    [second.fileId, second],
  ]);
}

const loadPage = async (fileId: string) => pages().get(fileId) ?? null;

describe("theme change previews (#66)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let site = "";
  before(async () => {
    await resetTestDatabase(url!);
    site = await siteForOwner("preview-owner");
    await readSiteTheme(site);
    await recordSitePage(site, { fileId: "second", path: "second" });
    await recordSitePage(site, { fileId: "about", path: "about", revisionId: "r1" });
    await recordSitePage(site, { fileId: "gone", path: "gone" });
  });
  after(closeDatabase);

  test("published pages are recorded once each, newest first", async () => {
    await recordSitePage(site, { fileId: "gone", path: "gone" });
    assert.deepEqual((await listSitePages(site)).map((page) => page.fileId), ["gone", "about", "second"]);
  });

  test("a theme switch previews every sampled page without touching the site", async () => {
    const before = await readSiteTheme(site);
    const preview = await previewChange(site, { themeName: "@pagefirst/editorial" }, { loadPage });
    assert.equal(preview.status, "open");
    const { report } = preview;
    assert.deepEqual([report.from.theme, report.to.theme], ["@pagefirst/default", "@pagefirst/editorial"]);
    assert.equal(report.pages, 3);
    assert.equal(report.sampled, 3);
    assert.equal(report.changed, 2);
    assert.equal(report.failed, 1, "a page whose Doc is gone is reported, not fatal");
    assert.equal(report.diff, "markup");
    const about = report.results.find((result) => result.fileId === "about")!;
    assert.equal(about.changed, true);
    assert.ok(about.candidate && about.live && about.candidate.htmlKb > 0);
    assert.deepEqual(about.breaches, []);
    const served = await readPreview(about.previewPath!.replace("/published/", ""));
    assert.match(served!.html, /class="masthead"/, "the candidate render is served as a preview");
    assert.deepEqual(await readSiteTheme(site), before, "nothing is saved until the change is applied");
    assert.equal((await readChangePreview(site, preview.id))!.report.changed, 2);
  });

  test("a token change on the same theme previews too, and an invalid change is refused", async () => {
    const preview = await previewChange(site, { tokens: { "color-brand": "#123456" } }, { loadPage, sample: 1 });
    assert.equal(preview.report.sampled, 1);
    await assert.rejects(previewChange(site, { themeName: "@someone/else" }, { loadPage }), /not an available theme/);
  });

  test("re-locking to the same version changes no page", async () => {
    await savePresentation(site, "about", { template: "page" });
    const preview = await previewChange(site, { versionRange: "^1.0.0" }, { loadPage });
    assert.equal(preview.report.changed, 0);
  });

  test("applying saves the previewed lock and returns the pages to republish", async () => {
    const preview = await previewChange(site, { themeName: "@pagefirst/editorial" }, { loadPage });
    const applied = await applyChange(site, preview.id);
    assert.equal(applied.config.themeName, "@pagefirst/editorial");
    assert.equal((await readSiteTheme(site)).lock.integrity, applied.config.lock.integrity);
    assert.deepEqual(applied.republish.map((page) => page.fileId).sort(), ["about", "gone", "second"]);
    assert.equal((await readChangePreview(site, preview.id))!.status, "applied");
    await assert.rejects(applyChange(site, preview.id), /already applied/);
    await assert.rejects(discardChange(site, preview.id), /already applied/);
  });

  test("a stale preview cannot be applied after the site's theme moved on", async () => {
    const preview = await previewChange(site, { themeName: "@pagefirst/default" }, { loadPage });
    await updateSiteTheme(site, { tokens: { "color-brand": "#000000" } });
    await assert.rejects(applyChange(site, preview.id), /changed since this preview/);
    assert.equal((await readSiteTheme(site)).themeName, "@pagefirst/editorial");
  });

  test("discarding leaves the site alone; another site's preview is not found", async () => {
    const preview = await previewChange(site, { themeName: "@pagefirst/default" }, { loadPage });
    const other = await siteForOwner("someone-else");
    await assert.rejects(discardChange(other, preview.id), /not found/);
    await assert.rejects(applyChange(other, preview.id), /not found/);
    await discardChange(site, preview.id);
    assert.equal((await readChangePreview(site, preview.id))!.status, "discarded");
    assert.equal((await readSiteTheme(site)).themeName, "@pagefirst/editorial");
  });
});
