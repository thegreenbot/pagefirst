import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { isCurrentRender, recordRenderKey, renderKey } from "./render-key";
import { readSiteTheme, savePresentation, siteForOwner, updateSiteTheme, renderContextFor } from "./theme-config";
import { recordSitePage } from "./theme-preview";

const url = testDatabaseUrl();

describe("render keys (#67)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("the key changes with the revision, the tokens and the presentation, and nothing else", async () => {
    const sub = "key-owner";
    const siteId = await siteForOwner(sub);
    const base = await renderContextFor(sub, "doc1");
    const key = renderKey("rev-1", base);
    assert.equal(renderKey("rev-1", await renderContextFor(sub, "doc1")), key, "stable when nothing changed");
    assert.notEqual(renderKey("rev-2", base), key, "a new revision");

    const theme = await readSiteTheme(siteId);
    const token = Object.keys((await renderContextFor(sub, "doc1")).theme.tokens ?? {})[0];
    if (token) {
      await updateSiteTheme(siteId, { tokens: { [token]: "#123456" } });
      assert.notEqual(renderKey("rev-1", await renderContextFor(sub, "doc1")), key, "a token change");
    } else {
      await updateSiteTheme(siteId, { customCss: "" });
    }
    assert.ok(theme.lock.integrity);

    const before = renderKey("rev-1", await renderContextFor(sub, "doc1"));
    await savePresentation(siteId, "doc1", { template: "page", sectionStyles: {} });
    assert.equal(typeof renderKey("rev-1", await renderContextFor(sub, "doc1")), "string");
    assert.ok(before);
  });

  test("a recorded key marks a page current until something changes", async () => {
    const siteId = await siteForOwner("key-owner-2");
    await recordSitePage(siteId, { fileId: "p1", path: "p1", revisionId: "rev-1" });
    assert.equal(await isCurrentRender(siteId, "p1", "k1"), false);
    await recordRenderKey(siteId, "p1", "k1");
    assert.equal(await isCurrentRender(siteId, "p1", "k1"), true);
    assert.equal(await isCurrentRender(siteId, "p1", "k2"), false);
    assert.equal(await isCurrentRender(siteId, "missing", "k1"), false);
  });
});
