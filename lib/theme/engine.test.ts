import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { aboutFixture } from "@/lib/page/fixture";
import type { Block, Page, Prose } from "@/lib/page/types";
import { renderPage } from "./engine";
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
