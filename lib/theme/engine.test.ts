import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { aboutFixture } from "@/lib/page/fixture";
import type { Block, Page, Prose } from "@/lib/page/types";
import { nodeOptimizer, publishedCsp } from "./csp";
import { renderPage } from "./engine";
import { ISLAND_LOADER } from "./islands";
import { parseManifest } from "./manifest";
import { getDefaultTheme, loadThemeFromDir, type ThemePackage } from "./package";

const schema = JSON.parse(readFileSync("lib/theme/theme.schema.json", "utf8"));

function prose(id: string, tag: Prose["tag"], text?: string, image?: Prose["image"]): Prose {
  return { kind: "prose", id, tag, text, image };
}

function block(id: string, name: string, options: string[], children: Prose[]): Block {
  return { kind: "block", id, name, options, rows: [[{ id: `${id}-c`, children }]] };
}

function page(sections: Page["sections"]): Page {
  return { fileId: "f", revisionId: "r1", path: "p", metadata: { title: "T" }, sections };
}

function inlineTheme(templates: Record<string, string>, blocks: Record<string, string> = {}): ThemePackage {
  const all: Record<string, string> = { ...templates };
  for (const [name, source] of Object.entries(blocks)) all[`blocks/${name}/block`] = source;
  return {
    manifest: parseManifest({
      name: "@test/inline",
      version: "0.0.1",
      engine: 1,
      templates: { page: { label: "Page" } },
      blocks: Object.fromEntries(Object.keys(blocks).map((name) => [name, { label: name }])),
    }),
    templates: all,
    baseCss: "",
    blockCss: {},
    tokens: {},
  };
}

describe("theme manifest", () => {
  test("the default theme's theme.json matches the JSON Schema", () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    const manifest = JSON.parse(readFileSync("themes/default/theme.json", "utf8"));
    assert.ok(validate(manifest), JSON.stringify(validate.errors));
  });

  test("the schema rejects unknown fields and a missing page template", () => {
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const base = { name: "@a/b", version: "1.0.0", engine: 1, templates: { page: { label: "P" } }, blocks: {} };
    assert.ok(validate(base));
    assert.equal(validate({ ...base, extra: true }), false);
    assert.equal(validate({ ...base, templates: { other: { label: "O" } } }), false);
    assert.equal(validate({ ...base, budgets: { htmlKb: 50 } }), false, "budgets can only tighten");
  });

  test("parseManifest refuses an unsupported engine and bad names", () => {
    const base = { name: "@a/b", version: "1.0.0", engine: 1, templates: { page: {} }, blocks: {} };
    assert.throws(() => parseManifest({ ...base, engine: 2 }), /engine 2/);
    assert.throws(() => parseManifest({ ...base, templates: {} }), /templates.page/);
    assert.throws(() => parseManifest({ ...base, blocks: { "../x": {} } }), /not a valid/);
    assert.throws(() => parseManifest(null), /object/);
  });

  test("loadThemeFromDir loads the default theme's templates and block CSS", () => {
    const theme = loadThemeFromDir("themes/default");
    assert.equal(theme.manifest.name, "@pagefirst/default");
    assert.ok("layouts/page" in theme.templates);
    assert.ok("blocks/hero/block" in theme.templates);
    assert.match(theme.blockCss.hero, /\.hero/);
  });
});

describe("renderPage with the default theme", () => {
  const theme = getDefaultTheme();

  test("renders the fixture Doc in the EDS shape", () => {
    const { html, warnings } = renderPage(aboutFixture(), theme);
    assert.deepEqual(warnings, []);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<main>/);
    assert.equal((html.match(/class="section"/g) ?? []).length, 3);
    assert.ok(html.includes('<div class="hero">'));
    assert.ok(html.includes('<div class="columns contained">'));
    assert.ok(html.includes('<img src="/api/media/sample-studio" alt="Studio"'));
  });

  test("ships CSS only for the blocks on the page", () => {
    const { html } = renderPage(aboutFixture(), theme);
    assert.match(html, /\.hero\{/);
    assert.match(html, /\.columns\{/);
    assert.doesNotMatch(html, /\.cards\{/);
  });

  test("edit output equals publish output once data-pf-id is removed", () => {
    const fixture = aboutFixture();
    const published = renderPage(fixture, theme, { mode: "publish" }).html;
    const edited = renderPage(fixture, theme, { mode: "edit" }).html;
    assert.equal(published.includes("data-pf-id"), false);
    assert.ok(edited.includes(`data-pf-id="${fixture.sections[0].id}"`));
    assert.ok(edited.includes(`data-pf-id="${fixture.sections[1].children[0].id}"`));
    assert.equal(edited.replace(/ data-pf-id="[^"]*"/g, ""), published);
  });

  test("the first image above the fold loads eagerly and the rest lazily", () => {
    const { html } = renderPage(
      page([
        { id: "s0", style: [], children: [prose("a", "img", undefined, { driveFileId: "one", alt: "" }), prose("b", "img", undefined, { driveFileId: "two", alt: "" })] },
        { id: "s1", style: [], children: [prose("c", "img", undefined, { driveFileId: "three", alt: "" })] },
      ]),
      theme,
    );
    const images = [...html.matchAll(/<img [^>]*>/g)].map((m) => m[0]);
    assert.equal(images.length, 3);
    assert.match(images[0], /fetchpriority="high"/);
    assert.doesNotMatch(images[0], /loading=/);
    assert.match(images[1], /loading="lazy"/);
    assert.match(images[2], /loading="lazy"/);
  });

  test("an undeclared block renders plain markup and is reported", () => {
    const { html, warnings } = renderPage(
      page([{ id: "s", style: [], children: [block("b", "carousel", ["wide"], [prose("p", "p", "Hi")])] }]),
      theme,
      { mode: "edit" },
    );
    assert.ok(html.includes('<div class="carousel wide" data-pf-id="b"><div><p data-pf-id="p">Hi</p></div></div>'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"carousel" is not in @pagefirst\/default/);
  });

  test("options a block does not declare are dropped and reported", () => {
    const { html, warnings } = renderPage(
      page([{ id: "s", style: [], children: [block("b", "columns", ["contained", "huge"], [])] }]),
      theme,
    );
    assert.ok(html.includes('<div class="columns contained">'));
    assert.match(warnings[0], /"columns" does not support "huge"/);
  });

  test("an unknown template is an error", () => {
    assert.throws(() => renderPage(aboutFixture(), theme, { template: "landing" }), /no "landing" template/);
  });
});

describe("theme sandbox", () => {
  const doc = page([{ id: "s", style: [], children: [prose("p", "p", "<b>bold</b>")] }]);

  test("Doc text printed by a template is escaped", () => {
    const theme = inlineTheme({ "layouts/page": "{% for s in page.sections %}{% for n in s.children %}{{ n.text }}{% endfor %}{% endfor %}" });
    assert.equal(renderPage(doc, theme).html, "&lt;b&gt;bold&lt;/b&gt;");
  });

  test("the raw filter is refused", () => {
    const theme = inlineTheme({ "layouts/page": "{{ page.title | raw }}" });
    assert.throws(() => renderPage(doc, theme), /raw filter is not available/);
  });

  test("include and layout are refused, and unknown filters are errors", () => {
    assert.throws(() => renderPage(doc, inlineTheme({ "layouts/page": "{% include 'x' %}" })), /not available in themes/);
    assert.throws(() => renderPage(doc, inlineTheme({ "layouts/page": "{% layout 'x' %}" })), /not available in themes/);
    assert.throws(() => renderPage(doc, inlineTheme({ "layouts/page": "{{ 'a' | nope }}" })), /undefined filter/);
  });

  test("render only reaches files inside the package", () => {
    const theme = inlineTheme({ "layouts/page": "{% render '../../package.json' %}" });
    assert.throws(() => renderPage(doc, theme));
  });

  test("templates cannot see Drive ids or prototype members", () => {
    const withImage = page([{ id: "s", style: [], children: [prose("i", "img", undefined, { driveFileId: "secret-drive-id", alt: "a" })] }]);
    const theme = inlineTheme({
      "layouts/page": "{% for s in page.sections %}{% for n in s.children %}[{{ n.image.driveFileId }}][{{ n.image.alt }}][{{ n.constructor }}]{% endfor %}{% endfor %}",
    });
    assert.equal(renderPage(withImage, theme).html, "[][a][]");
  });

  test("a runaway loop hits the render limit", () => {
    const theme = inlineTheme({ "layouts/page": "{% for i in (1..100000000) %}x{% endfor %}" });
    assert.throws(() => renderPage(doc, theme), /limit/);
  });

  test("island renders its body and block templates get the block view", () => {
    const theme = inlineTheme(
      { "layouts/page": "{% for s in page.sections %}{% for n in s.children %}{% pf_node n %}{% endfor %}{% endfor %}" },
      { gallery: "{% island %}<div class=\"{{ block.name }}\" data-above=\"{{ block.aboveFold }}\">{% image block.rows[0][0].children[0] %}</div>{% endisland %}" },
    );
    const withGallery = page([{ id: "s", style: [], children: [block("g", "gallery", [], [prose("i", "img", undefined, { driveFileId: "x", alt: "a" })])] }]);
    const { html } = renderPage(withGallery, theme);
    assert.equal(html, '<div class="gallery" data-above="true"><img src="/api/media/x" alt="a" fetchpriority="high"></div>');
  });
});

describe("islands (#60)", () => {
  const layout = {
    "layouts/page":
      "<html><head>{% pf_head %}</head><body>{% for s in page.sections %}{% for n in s.children %}{% pf_node n %}{% endfor %}{% endfor %}{% pf_foot %}</body></html>",
  };
  const islandTheme = (load: "visible" | "idle" | "interaction" = "visible", template = "{% island %}<div class=\"map\">{{ block.name }}</div>{% endisland %}") => {
    const theme = inlineTheme(layout, { map: template, plain: "<div class=\"plain\"></div>" });
    theme.manifest.blocks.map.js = { load };
    theme.blockJs = { map: "export default (el) => { el.dataset.mounted = '1'; };" };
    return theme;
  };
  const twoSections = (first: string, second: string) =>
    page([
      { id: "s1", style: [], children: [block("a", first, [], [])] },
      { id: "s2", style: [], children: [block("b", second, [], [])] },
    ]);

  test("a page whose blocks declare no JS ships no script, and the CSP allows none", () => {
    const cases: [Page, ThemePackage][] = [
      [aboutFixture(), getDefaultTheme()],
      [twoSections("plain", "plain"), islandTheme()],
    ];
    for (const [fixture, theme] of cases) {
      const { html, csp, assets } = renderPage(fixture, theme, { csp: publishedCsp, optimizer: nodeOptimizer });
      for (const marker of ["<script", "modulepreload", "pf-island"]) assert.ok(!html.includes(marker), marker);
      assert.match(csp, /script-src 'none'/);
      assert.equal(assets.filter((asset) => asset.path.endsWith(".js")).length, 0);
    }
  });

  test("a block with JS mounts as an island with a hashed module and an inline loader", () => {
    const { html, csp, assets, warnings } = renderPage(twoSections("plain", "map"), islandTheme("idle"), {
      csp: publishedCsp,
      optimizer: nodeOptimizer,
    });
    assert.deepEqual(warnings, []);
    const moduleAsset = assets.find((asset) => asset.path.endsWith(".js"));
    assert.ok(moduleAsset);
    assert.match(moduleAsset.path, /^assets\/pf\/[a-f0-9]{16}\.js$/);
    assert.ok(html.includes(`<pf-island data-pf-src="/${moduleAsset.path}" data-pf-load="idle"><div class="map">map</div></pf-island>`));
    assert.equal(html.split("<script").length - 1, 1, "exactly one script element");
    assert.ok(html.includes(`<script>${ISLAND_LOADER}</script></body>`));
    assert.ok(html.includes("pf-island{display:contents}"));
    assert.doesNotMatch(html, /modulepreload/, "islands below the first section are not preloaded");
    const loaderHash = `'sha256-${createHash("sha256").update(ISLAND_LOADER).digest("base64")}'`;
    assert.ok(csp.includes(`script-src 'self' ${loaderHash}`));
  });

  test("only first-section islands get modulepreload", () => {
    const { html, assets } = renderPage(twoSections("map", "plain"), islandTheme(), { optimizer: nodeOptimizer });
    const moduleAsset = assets.find((asset) => asset.path.endsWith(".js"))!;
    assert.ok(html.includes(`<link rel="modulepreload" href="/${moduleAsset.path}">`));
  });

  test("the loader is inlined and stays under 1 KB", () => {
    assert.ok(Buffer.byteLength(ISLAND_LOADER) < 1024, `${Buffer.byteLength(ISLAND_LOADER)} bytes`);
  });

  test("the editor never ships island JavaScript", () => {
    const { html, assets } = renderPage(twoSections("map", "map"), islandTheme(), { mode: "edit", optimizer: nodeOptimizer });
    for (const marker of ["<script", "pf-island"]) assert.ok(!html.includes(marker), marker);
    assert.equal(assets.length, 0);
  });

  test("a JS block without {% island %} is reported and its module not shipped", () => {
    const { html, assets, warnings } = renderPage(twoSections("map", "plain"), islandTheme("visible", "<div class=\"map\"></div>"), {
      optimizer: nodeOptimizer,
    });
    assert.ok(!html.includes("<script"));
    assert.equal(assets.length, 0);
    assert.match(warnings.join("\n"), /no \{% island %\}/);
  });

  test("island JavaScript over the theme's budget is reported", () => {
    const theme = islandTheme();
    theme.manifest.budgets = { jsKb: 0.01 };
    const { warnings } = renderPage(twoSections("map", "plain"), theme, { optimizer: nodeOptimizer });
    assert.match(warnings.join("\n"), /over the 10 byte budget/);
  });

  test("manifests must name a load strategy, and block.js must be declared", () => {
    const base = { name: "@a/b", version: "1.0.0", engine: 1, templates: { page: {} } };
    assert.throws(() => parseManifest({ ...base, blocks: { map: { label: "Map", js: { load: "eager" } } } }), /js\.load/);
    const dir = mkdtempSync(path.join(tmpdir(), "pf-theme-"));
    writeFileSync(path.join(dir, "theme.json"), JSON.stringify({ ...base, blocks: { map: { label: "Map" } } }));
    mkdirSync(path.join(dir, "layouts"));
    writeFileSync(path.join(dir, "layouts", "page.liquid"), "x");
    mkdirSync(path.join(dir, "blocks", "map"), { recursive: true });
    writeFileSync(path.join(dir, "blocks", "map", "block.liquid"), "{% island %}x{% endisland %}");
    writeFileSync(path.join(dir, "blocks", "map", "block.js"), "export default () => {};");
    assert.throws(() => loadThemeFromDir(dir), /needs "js"/);
    writeFileSync(path.join(dir, "theme.json"), JSON.stringify({ ...base, blocks: { map: { label: "Map", js: { load: "visible" } } } }));
    assert.equal(loadThemeFromDir(dir).blockJs?.map, "export default () => {};");
  });
});

describe("headers for the published page (#63)", () => {
  const rendition = {
    width: 1200,
    height: 800,
    avif: [480, 1200].map((width) => ({ path: `assets/img/0123456789abcdef-${width}.avif`, width })),
    webp: [480, 1200].map((width) => ({ path: `assets/img/0123456789abcdef-${width}.webp`, width })),
  };

  test("the LCP image gets a preload Link header with its AVIF srcset", () => {
    const fixture = page([{ id: "s", style: [], children: [prose("i", "img", undefined, { driveFileId: "x", alt: "a" }), prose("j", "img", undefined, { driveFileId: "x", alt: "b" })] }]);
    const { preloads } = renderPage(fixture, getDefaultTheme(), { images: { x: rendition } });
    assert.deepEqual(preloads, [
      '</assets/img/0123456789abcdef-1200.avif>; rel=preload; as=image; type="image/avif"; imagesrcset="/assets/img/0123456789abcdef-480.avif 480w, /assets/img/0123456789abcdef-1200.avif 1200w"; imagesizes="(min-width: 1440px) 1440px, 100vw"; fetchpriority=high',
    ]);
    assert.deepEqual(renderPage(fixture, getDefaultTheme(), { mode: "edit", images: { x: rendition } }).preloads, []);
    assert.deepEqual(renderPage(aboutFixture(), getDefaultTheme()).preloads, [], "no renditions, no preload");
  });

  test("origins a theme declares join the CSP; others are refused", () => {
    const theme = inlineTheme({ "layouts/page": "{% pf_head %}" });
    theme.manifest.permissions = { connect: ["https://api.example.com"], frame: ["https://player.example.com"] };
    const { csp } = renderPage(page([]), theme, { csp: publishedCsp });
    assert.match(csp, /connect-src https:\/\/api\.example\.com/);
    assert.match(csp, /frame-src https:\/\/player\.example\.com/);
    assert.doesNotMatch(renderPage(page([]), getDefaultTheme(), { csp: publishedCsp }).csp, /connect-src|frame-src/);
    const base = { name: "@a/b", version: "1.0.0", engine: 1, templates: { page: {} }, blocks: {} };
    for (const permissions of [{ connect: ["http://insecure.example"] }, { connect: ["*"] }, { script: ["https://x.example"] }, { img: "https://x.example" }]) {
      assert.throws(() => parseManifest({ ...base, permissions }), /permissions/, JSON.stringify(permissions));
    }
  });

  test("custom CSS renders in the last layer, after the blocks", () => {
    const { html } = renderPage(aboutFixture(), getDefaultTheme(), { customCss: ".hero { color: red; }", optimizer: nodeOptimizer });
    assert.match(html, /@layer customer\{\.hero\{color:red;?\}\}/);
    assert.ok(html.indexOf("@layer blocks") < html.indexOf("@layer customer"));
  });

  test("no custom CSS means no customer layer", () => {
    const { html } = renderPage(aboutFixture(), getDefaultTheme(), { optimizer: nodeOptimizer });
    assert.ok(!html.includes("@layer customer"));
  });

  test("custom CSS that blows the critical budget is named in a warning", () => {
    const big = Array.from({ length: 4000 }, (_, i) => `.c${i}{margin:${i}px ${i * 3}px}`).join("");
    const { warnings } = renderPage(aboutFixture(), getDefaultTheme(), { customCss: big, optimizer: nodeOptimizer });
    assert.match(warnings.join("\n"), /Custom CSS/);
  });

  test("a template override replaces the theme's partial, and a stale path is skipped with a warning", () => {
    const theme = loadThemeFromDir("themes/editorial");
    const partial = "partials/colophon";
    const site = { name: "Acme" };
    const plain = renderPage(aboutFixture(), theme, { site, optimizer: nodeOptimizer });
    const over = renderPage(aboutFixture(), theme, { site, templateOverrides: { [partial]: "<!--overridden-->", "partials/nope": "x" }, optimizer: nodeOptimizer });
    assert.ok(over.html.includes("<!--overridden-->"));
    assert.ok(!plain.html.includes("<!--overridden-->"));
    assert.match(over.warnings.join("\n"), /partials\/nope.*skipped/);
    // The cached engine for the theme is untouched by an override.
    assert.ok(!renderPage(aboutFixture(), theme, { site, optimizer: nodeOptimizer }).html.includes("<!--overridden-->"));
  });
});
