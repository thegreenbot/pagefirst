import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { budgetsFor, checkBudgets, DEFAULT_BUDGETS, measure, shipsJs } from "./budgets";
import { nodeOptimizer, publishedCsp } from "./csp";
import { renderPage } from "./engine";
import { themeFixtures } from "./fixtures";
import { getDefaultTheme, type ThemePackage } from "./package";

const render = (theme: ThemePackage, page = themeFixtures(theme.manifest)[0].page) =>
  renderPage(page, theme, { mode: "publish", csp: publishedCsp, optimizer: nodeOptimizer });

describe("theme budgets (#58)", () => {
  test("every default theme fixture meets the byte budgets", () => {
    const theme = getDefaultTheme();
    const budgets = budgetsFor(theme.manifest);
    for (const fixture of themeFixtures(theme.manifest)) {
      const breaches = checkBudgets(measure(render(theme, fixture.page), nodeOptimizer.gzipSize), budgets);
      assert.deepEqual(breaches, [], fixture.name);
    }
  });

  test("fixtures cover every declared block with all of its options", () => {
    const theme = getDefaultTheme();
    const everyBlock = themeFixtures(theme.manifest).find((fixture) => fixture.name === "every-block")!;
    const blocks = everyBlock.page.sections.flatMap((section) => section.children.filter((child) => child.kind === "block"));
    assert.deepEqual(blocks.map((block) => block.name).sort(), Object.keys(theme.manifest.blocks).sort());
    for (const block of blocks) assert.deepEqual(block.options, theme.manifest.blocks[block.name].options ?? []);
    assert.deepEqual(render(theme, everyBlock.page).warnings, []);
  });

  test("a theme can only tighten budgets, and one without islands gets no JS", () => {
    const manifest = { ...getDefaultTheme().manifest, budgets: { htmlKb: 8, totalCssKb: 99 } };
    const budgets = budgetsFor(manifest);
    assert.equal(budgets.htmlKb, 8);
    assert.equal(budgets.totalCssKb, DEFAULT_BUDGETS.totalCssKb);
    assert.equal(budgets.jsKb, 0);
    const withIsland = { ...manifest, blocks: { ...manifest.blocks, map: { label: "Map", js: { load: "idle" as const } } } };
    assert.equal(budgetsFor(withIsland).jsKb, DEFAULT_BUDGETS.jsKb);
  });

  test("CSS that pushes a theme over budget is reported by name", () => {
    const theme = getDefaultTheme();
    // Incompressible CSS: 40 KB of distinct custom properties.
    const heavy: ThemePackage = { ...theme, baseCss: `${theme.baseCss}:root{${randomBytes(20_000).toString("hex").match(/.{16}/g)!.map((v, i) => `--x${i}:${v}`).join(";")}}` };
    const breaches = checkBudgets(measure(render(heavy), nodeOptimizer.gzipSize), budgetsFor(heavy.manifest));
    const names = breaches.map((breach) => breach.budget);
    assert.ok(names.includes("totalCssKb"), JSON.stringify(breaches));
    assert.ok(names.includes("htmlKb"));
    assert.match(breaches[0].label, /compressed/);
  });

  test("measures inline and deferred CSS, scripts, island modules and preloaded fonts", () => {
    const measured = measure(
      {
        html: '<style>a{}</style><script>x()</script><link rel="preload" href="/f.woff2" as="font" crossorigin><link rel="preload" href="/g.woff2" as="font">',
        assets: [
          { path: "assets/pf/a.css", contentType: "text/css; charset=utf-8", body: "b{}" },
          { path: "assets/pf/a.js", contentType: "text/javascript; charset=utf-8", body: "y()" },
          { path: "f.woff2", contentType: "font/woff2", body: "x".repeat(100) },
        ],
      },
      (text) => text.length,
    );
    assert.equal(measured.criticalCssKb, 3);
    assert.equal(measured.totalCssKb, 6);
    assert.equal(measured.jsKb, 6);
    assert.equal(measured.preloadedFonts, 2);
    assert.equal(measured.fontKb, 100);
    const breaches = checkBudgets(measured, { ...DEFAULT_BUDGETS, jsKb: 0, preloadedFonts: 1 });
    assert.deepEqual(breaches.map((breach) => [breach.budget, breach.unit]), [["jsKb", "bytes"], ["preloadedFonts", "files"]]);
  });

  test("knows whether a page ships JavaScript, which decides if TBT is enforced", () => {
    assert.equal(shipsJs(render(getDefaultTheme())), false);
    assert.equal(shipsJs({ html: "<p>x</p><script>y()</script>", assets: [] }), true);
    assert.equal(shipsJs({ html: "<p>x</p>", assets: [{ path: "assets/pf/a.js", contentType: "text/javascript; charset=utf-8", body: "y()" }] }), true);
  });
});
