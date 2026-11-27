import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { aboutFixture } from "@/lib/page/fixture";
import { nodeOptimizer, publishedCsp } from "./csp";
import { renderPage } from "./engine";
import { usedFonts } from "./fonts";
import { parseManifest, type ManifestFont } from "./manifest";
import { getDefaultTheme } from "./package";

const theme = getDefaultTheme();
const publish = { mode: "publish" as const, optimizer: nodeOptimizer, csp: publishedCsp };

describe("theme fonts (#62)", () => {
  test("the default theme validates against the schema with its fonts", () => {
    const schema = JSON.parse(readFileSync("lib/theme/theme.schema.json", "utf8"));
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const manifest = JSON.parse(readFileSync("themes/default/theme.json", "utf8")) as { fonts: unknown[] };
    assert.ok(validate(manifest), JSON.stringify(validate.errors));
    assert.equal(manifest.fonts.length, 1);
  });

  test("a published page self-hosts each subset with unicode-range and a metric-matched fallback", () => {
    const { html, assets, warnings, csp } = renderPage(aboutFixture(), theme, publish);
    assert.deepEqual(warnings, []);
    const fonts = assets.filter((asset) => asset.contentType === "font/woff2");
    assert.equal(fonts.length, 2, "latin and latin-ext");
    for (const font of fonts) {
      assert.match(font.path, /^assets\/pf\/[a-f0-9]{16}\.woff2$/);
      assert.ok(font.body instanceof Uint8Array);
      assert.equal(Buffer.from(font.body).subarray(0, 4).toString("latin1"), "wOF2");
      assert.ok(html.includes(`src:url(/${font.path}) format("woff2")`));
    }
    assert.equal((html.match(/@font-face\{font-family:"Source Serif 4";/g) ?? []).length, 2);
    assert.match(html, /font-display:optional/);
    assert.match(html, /unicode-range:U\+0000-00FF,/);
    assert.ok(html.includes('@font-face{font-family:"Source Serif 4 Fallback";src:local("Georgia"),local("Times New Roman");size-adjust:110.18%;ascent-override:94.03%;descent-override:30.4%;line-gap-override:0%}'));
    assert.match(csp, /font-src 'self'/);
    assert.doesNotMatch(html, /data:font/);
  });

  test("only the latin subset is preloaded, in the head and as an Early Hints Link", () => {
    const { html, preloads, assets } = renderPage(aboutFixture(), theme, publish);
    const links = [...html.matchAll(/<link rel="preload"[^>]*as="font"[^>]*>/g)].map((m) => m[0]);
    assert.equal(links.length, 1);
    const href = /href="([^"]+)"/.exec(links[0])![1];
    assert.match(links[0], /type="font\/woff2" crossorigin>/);
    const latin = assets.find((asset) => `/${asset.path}` === href)!;
    assert.equal(latin.body.length, readFileSync("themes/default/assets/fonts/source-serif-4-latin-600.woff2").length);
    assert.ok(html.indexOf(links[0]) < html.indexOf("</head>"));
    assert.ok(preloads.includes(`<${href}>; rel=preload; as=font; type="font/woff2"; crossorigin`));
  });

  test("the editor inlines fonts as data: URLs and ships no font files", () => {
    const { html, assets } = renderPage(aboutFixture(), theme, { ...publish, mode: "edit" });
    assert.equal(assets.length, 0);
    assert.match(html, /src:url\(data:font\/woff2;base64,d09GMg/);
    assert.doesNotMatch(html, /rel="preload"[^>]*as="font"/);
  });

  test("a site that picks another heading font ships no theme font", () => {
    const { html, assets, preloads } = renderPage(aboutFixture(), theme, { ...publish, tokens: { "font-heading": "Arial, sans-serif" } });
    assert.equal(assets.filter((asset) => asset.contentType === "font/woff2").length, 0);
    assert.doesNotMatch(html, /@font-face/);
    assert.equal(preloads.filter((link) => link.includes("as=font")).length, 0);
  });

  test("a family counts as used only when a token names it exactly", () => {
    const fonts = [{ family: "Inter" }, { family: "Inter Tight" }] as ManifestFont[];
    assert.deepEqual(usedFonts(fonts, { a: "'Inter Tight', sans-serif" }).map((f) => f.family), ["Inter Tight"]);
    assert.deepEqual(usedFonts(fonts, { a: "Inter, sans-serif", b: 4 }).map((f) => f.family), ["Inter"]);
    assert.deepEqual(usedFonts(fonts, { a: "Interstate" }), []);
  });
});

describe("theme.json fonts validation", () => {
  const base = { name: "t", version: "1.0.0", engine: 1, templates: { page: {} }, blocks: {} };
  const font = (overrides: Record<string, unknown> = {}, file: Record<string, unknown> = {}, fallback: Record<string, unknown> = {}) => ({
    family: "Inter",
    files: [{ src: "assets/fonts/inter-latin.woff2", subset: "latin", unicodeRange: "U+0000-00FF", ...file }],
    fallback: { local: ["Arial"], sizeAdjust: "107%", ...fallback },
    ...overrides,
  });

  test("accepts a well-formed font", () => {
    assert.doesNotThrow(() => parseManifest({ ...base, fonts: [font()] }));
  });

  const bad: [string, unknown][] = [
    ["a family that could break out of CSS", font({ family: 'Inter";}body{x:y' })],
    ["a file outside assets/fonts", font({}, { src: "../secret.woff2" })],
    ["a non-woff2 file", font({}, { src: "assets/fonts/inter.ttf" })],
    ["an unknown subset", font({}, { subset: "klingon" })],
    ["an injected unicode-range", font({}, { unicodeRange: "U+0000;}body{x:y" })],
    ["a fallback that is not a percentage", font({}, {}, { sizeAdjust: "1;x" })],
    ["a quoted local fallback", font({}, {}, { local: ['Arial")'] })],
    ["a bad weight", font({ weight: "bold;" })],
  ];
  for (const [what, value] of bad) {
    test(`rejects ${what}`, () => {
      assert.throws(() => parseManifest({ ...base, fonts: [value] }), /theme\.json/);
    });
  }

  test("rejects more than one preloaded font", () => {
    assert.throws(() => parseManifest({ ...base, fonts: [font({ preload: true }), font({ family: "Lora", preload: true })] }), /at most one/);
  });
});
