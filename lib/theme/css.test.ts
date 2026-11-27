import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { renderPage } from "./engine";
import { minifyCss, pruneUnusedOptions } from "./css";
import { nodeOptimizer, publishedCsp } from "./csp";
import { parseManifest } from "./manifest";
import type { ThemePackage } from "./package";
import type { Block, Page } from "@/lib/page/types";

describe("minifyCss", () => {
  test("drops comments and whitespace without changing meaning", () => {
    assert.equal(minifyCss("/* x */ a  >  b ,  c {\n  color: red ;\n  margin: 0 auto;\n}\n"), "a>b,c{color:red;margin:0 auto}");
  });

  test("keeps the spaces calc() and media queries need", () => {
    assert.equal(minifyCss("a { width: calc(100% - 2rem + 1px) }"), "a{width:calc(100% - 2rem + 1px)}");
    assert.equal(minifyCss("@media screen and (min-width: 40rem) { a { b: c } }"), "@media screen and (min-width:40rem){a{b:c}}");
  });

  test("keeps strings and descendant pseudo-classes", () => {
    assert.equal(minifyCss(`a::before { content: "  /* not a comment */  " }`), `a::before{content:"  /* not a comment */  "}`);
    assert.equal(minifyCss("nav :hover { x: y }"), "nav :hover{x:y}");
  });
});

describe("pruneUnusedOptions", () => {
  const unused = { columns: ["contained"] };

  test("drops selectors that need an unused option and keeps the rest", () => {
    assert.equal(
      pruneUnusedOptions(".columns{a:b}.columns.contained{c:d}.columns.contained>div,.columns>div{e:f}", unused),
      ".columns{a:b}.columns>div{e:f}",
    );
  });

  test("looks inside @media and leaves other at-rules and look-alike names alone", () => {
    assert.equal(
      pruneUnusedOptions("@media (min-width:40rem){.columns.contained{a:b}.x{c:d}}@font-face{font-family:x}.columns.contained-ish{e:f}", unused),
      "@media (min-width:40rem){.x{c:d}}@font-face{font-family:x}.columns.contained-ish{e:f}",
    );
  });

  test("returns the input when braces do not balance", () => {
    assert.equal(pruneUnusedOptions(".columns.contained{a:b", unused), ".columns.contained{a:b");
  });
});

function block(id: string, name: string, options: string[] = []): Block {
  return { kind: "block", id, name, options, rows: [[{ id: `${id}c`, children: [] }]] };
}

function page(sections: Block[][]): Page {
  return {
    fileId: "f",
    revisionId: "r1",
    path: "p",
    metadata: { title: "T" },
    sections: sections.map((children, index) => ({ id: `s${index}`, style: [], children })),
  };
}

/** Random-looking CSS compresses badly, so it can push a page over the budget. */
function bulky(name: string, rules: number): string {
  let out = "";
  for (let i = 0; i < rules; i++) out += `.${name} .r${i}-${(i * 2654435761).toString(36)}{margin:${i % 97}px ${(i * 7) % 89}px}`;
  return out;
}

function theme(blockCss: Record<string, string>): ThemePackage {
  const names = Object.keys(blockCss);
  const templates: Record<string, string> = {
    "layouts/page": "<html><head>{% pf_head %}</head><body>{% for s in page.sections %}{% for n in s.children %}{% pf_node n %}{% endfor %}{% endfor %}</body></html>",
  };
  for (const name of names) templates[`blocks/${name}/block`] = `<div class="{{ block.options | classes: block.name }}"></div>`;
  return {
    manifest: parseManifest({
      name: "@test/css",
      version: "0.0.1",
      engine: 1,
      templates: { page: { label: "Page" } },
      blocks: Object.fromEntries(names.map((name) => [name, { label: name, options: ["wide"] }])),
    }),
    templates,
    baseCss: "body { margin: 0 }",
    blockCss,
    tokens: {},
  };
}

describe("page CSS", () => {
  const options = { csp: publishedCsp, optimizer: nodeOptimizer };

  test("a page using two blocks ships only those two blocks' CSS, inline", () => {
    const t = theme({ hero: ".hero{a:b}", cards: ".cards{c:d}", quote: ".quote{e:f}" });
    const { html, assets, csp } = renderPage(page([[block("h", "hero")], [block("c", "cards")]]), t, options);
    assert.ok(html.includes("<style>@layer theme{body{margin:0}}@layer blocks{.hero{a:b}.cards{c:d}}</style>"));
    assert.doesNotMatch(html, /\.quote/);
    assert.deepEqual(assets, []);
    assert.doesNotMatch(csp, /style-src 'self'/);
  });

  test("selectors for options the page does not use are dropped", () => {
    const t = theme({ hero: ".hero{a:b}.hero.wide{c:d}" });
    assert.doesNotMatch(renderPage(page([[block("h", "hero")]]), t, options).html, /\.wide/);
    assert.match(renderPage(page([[block("h", "hero", ["wide"])]]), t, options).html, /\.hero\.wide\{c:d\}/);
  });

  test("over budget, first-section CSS is inlined and the rest is one deferred file", () => {
    const t = theme({ hero: ".hero{a:b}", cards: bulky("cards", 1500), quote: ".quote{e:f}" });
    const { html, assets, csp } = renderPage(page([[block("h", "hero")], [block("c", "cards"), block("q", "quote")]]), t, options);
    const inline = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    assert.equal(inline, "@layer theme{body{margin:0}}@layer blocks{.hero{a:b}}");
    assert.equal(assets.length, 1);
    assert.match(assets[0].path, /^assets\/pf\/[a-f0-9]{16}\.css$/);
    assert.ok(String(assets[0].body).startsWith("@layer blocks{.cards .r0"));
    assert.ok(String(assets[0].body).endsWith(".quote{e:f}}"));
    assert.ok(gzipSync(String(assets[0].body)).length > 10 * 1024);
    // Loaded at the end of <body>, so it never blocks the first paint.
    assert.ok(html.includes(`<link rel="stylesheet" href="/${assets[0].path}">\n</body>`));
    assert.match(csp, /style-src 'self' 'sha256-/);
  });

  test("pages with the same block set share the deferred file", () => {
    const t = theme({ hero: ".hero{a:b}", cards: bulky("cards", 1500) });
    const one = renderPage(page([[block("h", "hero")], [block("c", "cards")]]), t, options).assets[0].path;
    const two = renderPage(page([[block("h2", "hero")], [block("c2", "cards"), block("c3", "cards")]]), t, options).assets[0].path;
    assert.equal(one, two);
  });

  test("the editor preview always inlines everything", () => {
    const t = theme({ hero: ".hero{a:b}", cards: bulky("cards", 1500) });
    const { html, assets } = renderPage(page([[block("h", "hero")], [block("c", "cards")]]), t, { ...options, mode: "edit" });
    assert.deepEqual(assets, []);
    assert.doesNotMatch(html, /<link rel="stylesheet"/);
  });
});

describe("preview assets", () => {
  test("are stored by path and size-capped", async () => {
    const { readPreviewAsset, savePreviewAssets } = await import("@/lib/publish/preview");
    savePreviewAssets([
      { path: "assets/pf/0123456789abcdef.css", contentType: "text/css; charset=utf-8", body: ".a{b:c}" },
      { path: "assets/pf/ffffffffffffffff.css", contentType: "text/css; charset=utf-8", body: "x".repeat(1_000_001) },
    ]);
    assert.equal(readPreviewAsset("assets/pf/0123456789abcdef.css")?.body, ".a{b:c}");
    assert.equal(readPreviewAsset("assets/pf/ffffffffffffffff.css"), null);
  });
});
