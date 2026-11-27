import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, query } from "@/lib/db/client";
import { PlanError } from "@/lib/tenant/plans";
import { setPlan, personalOrgId } from "@/lib/tenant/orgs";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import { renderPageHtml } from "@/lib/page/render";
import { getDefaultTheme } from "@/lib/theme/package";
import { packageIntegrity, satisfies } from "@/lib/theme/registry";
import { withPresentation } from "@/lib/theme/presentation";
import {
  ConfigError,
  lockedPackage,
  orphans,
  readPresentation,
  readSiteTheme,
  renderContextFor,
  savePresentation,
  siteForOwner,
  updateSiteTheme,
  validatePresentation,
  validateUpdate,
} from "./theme-config";

const manifest = getDefaultTheme().manifest;

describe("theme config validation", () => {
  test("accepts tokens, settings, custom CSS, overrides and locks", () => {
    const update = validateUpdate(
      {
        tokens: { "color-brand": "#1a4738", "space-2": 8 },
        settings: {},
        customCss: ".x{color:red}",
        templateOverrides: { "blocks/hero/block": "<div></div>" },
        locks: ["tokens", "tokens"],
      },
      manifest,
    );
    assert.deepEqual(update.locks, ["tokens"]);
    assert.equal(update.tokens?.["space-2"], 8);
  });

  test("refuses values that could break out of CSS or reach other templates", () => {
    const bad: unknown[] = [
      { tokens: { brand: "red;}body{display:none" } },
      { tokens: { Brand: "red" } },
      { settings: { unknown: true } },
      { customCss: "</style><script>" },
      { customCss: "a{} <!-- x" },
      { customCss: '@import url("https://x.example/a.css");' },
      { templateOverrides: { "../secret": "x" } },
      { locks: ["everything"] },
      { versionRange: ">=1" },
      { themeName: "../evil" },
      { extra: 1 },
      null,
    ];
    for (const input of bad) assert.throws(() => validateUpdate(input, manifest), ConfigError, JSON.stringify(input));
  });

  test("with the theme loaded, only its declared tokens are accepted", () => {
    const theme = getDefaultTheme();
    assert.equal(validateUpdate({ tokens: { "color-brand": "#000" } }, manifest, theme).tokens?.["color-brand"], "#000");
    assert.throws(() => validateUpdate({ tokens: { "color-neon": "#0f0" } }, manifest, theme), /not a token/);
  });

  test("reports stored tokens and settings the theme does not declare", () => {
    const theme = getDefaultTheme();
    assert.deepEqual(orphans({ tokens: { "color-brand": "#000", gone: "1px" }, settings: { old: true } }, theme), {
      tokens: ["gone"],
      settings: ["old"],
    });
  });

  test("presentation must use the theme's templates and section styles", () => {
    assert.deepEqual(validatePresentation({ template: "page", sectionStyles: { s1: ["dark"], s2: [] } }, manifest), {
      template: "page",
      sectionStyles: { s1: ["dark"] },
    });
    assert.throws(() => validatePresentation({ template: "landing" }, manifest), ConfigError);
    assert.throws(() => validatePresentation({ sectionStyles: { s1: ["neon"] } }, manifest), ConfigError);
    assert.throws(() => validatePresentation({ sectionStyles: { "../x": ["dark"] } }, manifest), ConfigError);
  });

  test("version ranges", () => {
    assert.ok(satisfies("1.2.3", "^1.0.0"));
    assert.ok(!satisfies("2.0.0", "^1.0.0"));
    assert.ok(satisfies("1.2.9", "~1.2.0"));
    assert.ok(!satisfies("1.3.0", "~1.2.0"));
    assert.ok(satisfies("0.2.5", "^0.2.0"));
    assert.ok(!satisfies("0.3.0", "^0.2.0"));
    assert.ok(satisfies("1.0.0", "1.0.0"));
    assert.ok(!satisfies("1.0.1", "1.0.0"));
  });

  test("withPresentation uses only stored section styles once a site config exists", () => {
    const page = aboutFixture();
    page.sections[1].style = ["from-the-doc"];
    const stored = withPresentation(page, { settings: {}, tokens: {} }, { template: "page", sectionStyles: { [page.sections[2].id]: ["dark"] } });
    assert.deepEqual(stored.page.sections.map((s) => s.style), [[], [], ["dark"]]);
    // Without a stored site (sample mode), the Doc's styles still apply.
    assert.deepEqual(withPresentation(page, null, null).page.sections[1].style, ["from-the-doc"]);
  });
});

const url = testDatabaseUrl();

describe("site theme store", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("an owner gets one site, even when two requests race", async () => {
    const [a, b] = await Promise.all([siteForOwner("owner-1"), siteForOwner("owner-1")]);
    assert.equal(a, b);
    assert.notEqual(await siteForOwner("owner-2"), a);
  });

  test("the first read locks the default theme by version and integrity", async () => {
    const site = await siteForOwner("owner-1");
    const config = await readSiteTheme(site);
    assert.equal(config.themeName, "@pagefirst/default");
    assert.equal(config.versionRange, `^${manifest.version}`);
    assert.deepEqual(config.lock, { version: manifest.version, integrity: packageIntegrity(getDefaultTheme()) });
  });

  test("theme, tokens, settings and presentation survive a restart", async () => {
    const site = await siteForOwner("owner-1");
    await updateSiteTheme(site, { tokens: { "color-brand": "#123456" }, locks: ["tokens"] });
    await savePresentation(site, "about", { template: "page", sectionStyles: { s_x: ["highlight"] } });

    await closeDatabase();
    process.env.DATABASE_URL = url!;

    const config = await readSiteTheme(site);
    assert.deepEqual(config.tokens, { "color-brand": "#123456" });
    assert.deepEqual(config.locks, ["tokens"]);
    assert.deepEqual(await readPresentation(site, "about"), { template: "page", sectionStyles: { s_x: ["highlight"] } });
  });

  test("publishing renders with the locked package bytes, read back from the store", async () => {
    const site = await siteForOwner("owner-3");
    const config = await readSiteTheme(site);
    // Simulate a later deploy whose bundled theme changed: the lock still points at the stored snapshot.
    const stored = await lockedPackage(config.lock.integrity);
    const tampered = { ...stored, baseCss: "body{background:red}" };
    await query("UPDATE theme_packages SET package = $2 WHERE integrity = $1", [config.lock.integrity, JSON.stringify(tampered)]);
    const page = aboutFixture();
    const context = await renderContextFor("owner-3", page.fileId);
    // The in-process cache holds the original bytes; a fresh process reads the snapshot.
    assert.doesNotMatch(renderPageHtml(page, "publish", context).html, /background:red/);
    assert.equal(context.config?.lock.integrity, config.lock.integrity);
  });

  test("section styles come from the store, not the Doc", async () => {
    const page = aboutFixture();
    page.sections[1].style = ["doc-style"];
    const site = await siteForOwner("owner-4");
    await savePresentation(site, page.fileId, { sectionStyles: { [page.sections[2].id]: ["dark"] } });
    const html = renderPageHtml(page, "publish", await renderContextFor("owner-4", page.fileId)).html;
    assert.doesNotMatch(html, /doc-style/);
    assert.match(html, /class="section dark"/);
  });

  test("changing the range to one the bundled theme cannot satisfy is refused", async () => {
    const site = await siteForOwner("owner-1");
    await assert.rejects(updateSiteTheme(site, { versionRange: "^9.0.0" }), /does not satisfy/);
  });

  test("a render context without a signed-in owner uses the default theme", async () => {
    const context = await renderContextFor(null, "about");
    assert.equal(context.config, null);
    assert.equal(context.theme.manifest.name, "@pagefirst/default");
  });

  test("custom CSS needs a paid plan when hosted, can always be cleared, and stops rendering after a downgrade", async () => {
    const sub = "owner-css";
    const site = await siteForOwner(sub);
    process.env.PAGEFIRST_EDITION = "hosted";
    try {
      await assert.rejects(updateSiteTheme(site, { customCss: ".x{color:red}" }), PlanError);
      assert.equal((await readSiteTheme(site)).customCss, "");
      await setPlan(personalOrgId(sub), "pro");
      await updateSiteTheme(site, { customCss: ".x{color:red}" });
      assert.equal((await renderContextFor(sub, "f")).config?.customCss, ".x{color:red}");
      await setPlan(personalOrgId(sub), "free");
      assert.equal((await renderContextFor(sub, "f")).config?.customCss, "");
      assert.equal((await readSiteTheme(site)).customCss, ".x{color:red}");
      await updateSiteTheme(site, { customCss: "" });
      assert.equal((await readSiteTheme(site)).customCss, "");
    } finally {
      delete process.env.PAGEFIRST_EDITION;
    }
  });
});
