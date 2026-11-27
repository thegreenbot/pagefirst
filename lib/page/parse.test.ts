import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutFixture, blankPage } from "./fixture";
import { namedRangeSpecs, parseDocument } from "./parse";
import { renderPublishHtml } from "./render";
import { isSafeId } from "./types";
import type { Block, DocsDocument, DocsStructuralElement, Page, Prose } from "./types";

function para(
  text: string,
  extra?: {
    style?: string;
    start?: number;
    end?: number;
    bullet?: { listId?: string; glyph?: string; glyphType?: string };
    inlineObjectId?: string;
  },
): DocsStructuralElement {
  const elements: NonNullable<DocsStructuralElement["paragraph"]>["elements"] = [];
  if (extra?.inlineObjectId) {
    elements.push({ inlineObjectElement: { inlineObjectId: extra.inlineObjectId } });
  }
  elements.push({ textRun: { content: text } });
  return {
    startIndex: extra?.start,
    endIndex: extra?.end,
    paragraph: {
      elements,
      paragraphStyle: extra?.style ? { namedStyleType: extra.style } : undefined,
      bullet: extra?.bullet,
    },
  };
}

function cell(text: string, start?: number, end?: number) {
  return { content: [para(text, { start, end })] };
}

function studioDoc(): DocsDocument {
  return {
    documentId: "doc-1",
    revisionId: "rev-9",
    title: "Hello Page",
    body: {
      content: [
        para("Hello\n", { style: "HEADING_1", start: 1, end: 8 }),
        para("---\n", { start: 8, end: 12 }),
        {
          startIndex: 12,
          endIndex: 40,
          table: {
            rows: [
              { tableCells: [cell("metadata\n")] },
              { tableCells: [cell("title\n"), cell("About\n")] },
              { tableCells: [cell("template\n"), cell("landing\n")] },
              { tableCells: [cell("Theme\n"), cell("@x/y\n")] },
            ],
          },
        },
        {
          startIndex: 40,
          endIndex: 60,
          table: {
            rows: [
              { tableCells: [cell("hero\n")] },
              { tableCells: [cell("Hi\n")] },
            ],
          },
        },
      ],
    },
  };
}

function pageIds(page: Page): Set<string> {
  const ids = new Set<string>();
  for (const section of page.sections) {
    ids.add(section.id);
    for (const child of section.children) {
      ids.add(child.id);
      if (child.kind !== "block") continue;
      for (const row of child.rows) {
        for (const item of row) {
          ids.add(item.id);
          for (const prose of item.children) ids.add(prose.id);
        }
      }
    }
  }
  return ids;
}

function asProse(node: Page["sections"][number]["children"][number]): Prose {
  assert.equal(node.kind, "prose");
  if (node.kind !== "prose") throw new Error("expected prose");
  return node;
}

function asBlock(node: Page["sections"][number]["children"][number]): Block {
  assert.equal(node.kind, "block");
  if (node.kind !== "block") throw new Error("expected block");
  return node;
}

test("parses sections, metadata, and a hero block", () => {
  const doc = studioDoc();
  const page = parseDocument(doc);
  assert.equal(page.fileId, "doc-1");
  assert.equal(page.revisionId, "rev-9");
  assert.equal(page.path, "hello-page");
  assert.equal(page.sections.length, 2);
  assert.deepEqual(page.metadata, { title: "About" });

  const heading = asProse(page.sections[0].children[0]);
  assert.equal(page.sections[0].children.length, 1);
  assert.equal(heading.tag, "h1");
  assert.equal(heading.text, "Hello");

  assert.equal(page.sections[1].children.length, 1);
  const hero = asBlock(page.sections[1].children[0]);
  assert.equal(hero.name, "hero");
  assert.deepEqual(hero.options, []);
  assert.equal(hero.rows.length, 1);
  assert.equal(hero.rows[0][0].children[0].text, "Hi");

  assert.equal(parseDocument(doc, "custom/path").path, "custom/path");
  assert.equal(parseDocument({}).path, "index");
  assert.equal(parseDocument({}).fileId, "doc");
  assert.equal(parseDocument({}).revisionId, "r1");
  assert.equal(parseDocument({}).sections.length, 1);
  assert.deepEqual(parseDocument({}).sections[0].children, []);
  assert.equal(parseDocument({ title: "***" }).path, "index");
});

test("renderPublishHtml escapes markup and omits editor attributes", () => {
  const attack: Page = {
    fileId: "f",
    revisionId: "r1",
    path: "p",
    metadata: { title: "<script>", description: `a <script> "quote"` },
    sections: [
      {
        id: "s",
        style: ["<script>"],
        children: [
          { kind: "prose", id: "n", tag: "p", text: "<script>alert(1)</script>" },
          {
            kind: "block",
            id: "b",
            name: "<script>",
            options: [],
            rows: [
              [
                {
                  id: "c",
                  children: [
                    {
                      kind: "prose",
                      id: "i",
                      tag: "img",
                      image: { driveFileId: "<script>", alt: "it's <script>" },
                    },
                  ],
                },
              ],
            ],
          },
          { kind: "prose", id: "empty-img", tag: "img", image: { driveFileId: "", alt: "skip" } },
          { kind: "prose", id: "list", tag: "ul", items: ["a & b", "c < d"] },
        ],
      },
    ],
  };
  const html = renderPublishHtml(attack);
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<script"), false);
  assert.equal(html.includes("contenteditable"), false);
  assert.equal(/\son[a-z]+=/i.test(html), false);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("/api/media/&lt;script&gt;"));
  assert.ok(html.includes("alt=\"it&#39;s &lt;script&gt;\""));
  assert.ok(html.includes("<li>a &amp; b</li>"));
  assert.equal(html.includes("<img") ? html.includes('src="/api/media/&lt;script&gt;"') : false, true);
  assert.equal((html.match(/<img/g) ?? []).length, 1);

  const published = renderPublishHtml(parseDocument(studioDoc()));
  assert.equal(published.includes("contenteditable"), false);
  assert.match(published, /<title>About<\/title>/);
  assert.ok(published.includes(">Hello</h1>"));
  assert.ok(published.includes(">Hi</p>"));
  assert.ok(published.includes('class="hero"'));
});

test("namedRangeSpecs covers metadata and nodes with the parser's ids", () => {
  const doc = studioDoc();
  const page = parseDocument(doc);
  const specs = namedRangeSpecs(doc);
  assert.ok(specs.some((spec) => spec.name === "pg/meta"));
  assert.ok(specs.some((spec) => spec.name.startsWith("pg/node/")));
  const meta = specs.find((spec) => spec.name === "pg/meta");
  assert.deepEqual(meta, { name: "pg/meta", startIndex: 12, endIndex: 40 });
  const heading = asProse(page.sections[0].children[0]);
  const hero = asBlock(page.sections[1].children[0]);
  assert.ok(specs.some((spec) => spec.name === `pg/node/${heading.id}` && spec.endIndex === 8));
  assert.ok(specs.some((spec) => spec.name === `pg/section/${page.sections[1].id}` && spec.endIndex === 12));
  assert.ok(specs.some((spec) => spec.name === `pg/node/${hero.id}` && spec.endIndex === 60));
  for (const spec of specs) {
    assert.equal(typeof spec.startIndex, "number");
    assert.equal(typeof spec.endIndex, "number");
    if (spec.name === "pg/meta") continue;
    const id = spec.name.startsWith("pg/section/")
      ? spec.name.slice("pg/section/".length)
      : spec.name.slice("pg/node/".length);
    assert.ok(pageIds(page).has(id), spec.name);
  }

  const bare: DocsDocument = { body: { content: [para("Hi\n")] } };
  assert.deepEqual(namedRangeSpecs(bare), []);
});

test("reuses safe named ranges and ignores unsafe ids", () => {
  const doc: DocsDocument = {
    body: {
      content: [
        para("Hello\n", { style: "HEADING_1", start: 1, end: 10 }),
        para("Only\n", { start: 10, end: 16 }),
        para("---\n", { start: 16, end: 20 }),
        {
          startIndex: 20,
          endIndex: 50,
          table: {
            rows: [
              { tableCells: [cell("hero\n")] },
              { tableCells: [cell("Hi\n", 30, 36)] },
            ],
          },
        },
      ],
    },
    namedRanges: {
      "pg/node/not safe": {
        name: "pg/node/not safe",
        namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 10 }] }],
      },
      "pg/node/hello_1": {
        name: "pg/node/hello_1",
        namedRanges: [{ ranges: [{ startIndex: 1, endIndex: 10 }] }],
      },
      "pg/node/bad id": {
        name: "pg/node/bad id",
        namedRanges: [{ ranges: [{ startIndex: 10, endIndex: 16 }] }],
      },
      "pg/section/after": {
        namedRanges: [{ ranges: [{ startIndex: 16, endIndex: 20 }] }],
      },
      "pg/node/hero_block": {
        namedRanges: [{ ranges: [{ startIndex: 20, endIndex: 50 }] }],
      },
      "pg/node/wide": {
        namedRanges: [{ ranges: [{ startIndex: 0, endIndex: 80 }] }],
      },
      "pg/node/hi_text": {
        namedRanges: [{ ranges: [{ startIndex: 30, endIndex: 36 }] }],
      },
    },
  };
  const page = parseDocument(doc);
  const specs = namedRangeSpecs(doc);
  const heading = asProse(page.sections[0].children[0]);
  const only = asProse(page.sections[0].children[1]);
  const hero = asBlock(page.sections[1].children[0]);
  assert.equal(heading.id, "hello_1");
  assert.notEqual(only.id, "bad id");
  assert.equal(isSafeId(only.id), true);
  assert.equal(page.sections[1].id, "after");
  assert.equal(hero.id, "hero_block");
  assert.equal(hero.rows[0][0].children[0].id, "hi_text");
  assert.ok(specs.some((spec) => spec.name === "pg/node/hello_1" && spec.endIndex === 10));
  assert.ok(specs.some((spec) => spec.name === `pg/node/${only.id}` && spec.endIndex === 16));
  assert.ok(specs.some((spec) => spec.name === "pg/section/after" && spec.endIndex === 20));
  assert.ok(specs.some((spec) => spec.name === "pg/node/hero_block" && spec.endIndex === 50));
  assert.ok(specs.some((spec) => spec.name === "pg/node/hi_text" && spec.endIndex === 36));
  assert.equal(specs.some((spec) => spec.name === "pg/node/wide"), false);
});

test("parses blocks, lists, images, and section metadata", () => {
  const doc: DocsDocument = {
    title: "Studio Notes",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 20,
          table: {
            rows: [
              { tableCells: [cell("Section Metadata\n"), cell("\n")] },
              { tableCells: [cell("style\n"), cell("highlight\n")] },
            ],
          },
        },
        para("Hel", { start: 20, end: 23 }),
        {
          startIndex: 23,
          endIndex: 30,
          paragraph: {
            elements: [{ textRun: { content: "lo\n\n" } }],
            paragraphStyle: { namedStyleType: "HEADING_2" },
          },
        },
        para("\n", { start: 30, end: 31 }),
        para("One\n", { start: 31, end: 36, bullet: { listId: "ol-main" } }),
        para("Two\n", { start: 36, end: 41, bullet: { listId: "ol-main" } }),
        para("Dot\n", { start: 41, end: 46, bullet: { listId: "kix.bullet" } }),
        para("Num\n", { start: 46, end: 51, bullet: { listId: "kix.list", glyph: "1." } }),
        para("\n", { start: 51, end: 52, inlineObjectId: "drive-img" }),
        {
          startIndex: 52,
          endIndex: 90,
          table: {
            rows: [
              { tableCells: [cell("columns (contained, highlight)\n")] },
              {
                tableCells: [
                  { content: [para("Left\n", { start: 60, end: 66 }), para("More\n")] },
                  { content: [para("Right\n")] },
                ],
              },
            ],
          },
        },
        para("---\n", { start: 90, end: 94 }),
        para("After\n", { start: 94, end: 100, style: "HEADING_4" }),
      ],
    },
  };

  const merged = parseDocument({
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: 12,
          paragraph: {
            elements: [{ textRun: { content: "Hel" } }, { textRun: { content: "lo\n\n" } }],
            paragraphStyle: { namedStyleType: "HEADING_2" },
          },
        },
      ],
    },
  });
  assert.equal(asProse(merged.sections[0].children[0]).text, "Hello\n");
  assert.equal(asProse(merged.sections[0].children[0]).tag, "h2");

  const page = parseDocument(doc);
  assert.equal(page.path, "studio-notes");
  assert.equal(page.sections.length, 2);
  assert.deepEqual(page.sections[0].style, ["highlight"]);
  const children = page.sections[0].children;
  assert.equal(children.length, 7);
  assert.equal(asProse(children[0]).tag, "p");
  assert.equal(asProse(children[0]).text, "Hel");
  assert.equal(asProse(children[1]).tag, "h2");
  assert.equal(asProse(children[1]).text, "lo\n");
  assert.equal(asProse(children[2]).tag, "ol");
  assert.deepEqual(asProse(children[2]).items, ["One", "Two"]);
  assert.equal(asProse(children[3]).tag, "ul");
  assert.deepEqual(asProse(children[3]).items, ["Dot"]);
  assert.equal(asProse(children[4]).tag, "ol");
  assert.deepEqual(asProse(children[4]).items, ["Num"]);
  const image = asProse(children[5]);
  assert.equal(image.tag, "img");
  assert.deepEqual(image.image, { driveFileId: "drive-img", alt: "" });
  const block = asBlock(children[6]);
  assert.equal(block.name, "columns");
  assert.deepEqual(block.options, ["contained", "highlight"]);
  assert.equal(block.rows.length, 1);
  assert.equal(block.rows[0].length, 2);
  assert.deepEqual(
    block.rows[0][0].children.map((item) => item.text),
    ["Left", "More"],
  );
  assert.deepEqual(
    block.rows[0][1].children.map((item) => item.text),
    ["Right"],
  );
  assert.equal(asProse(page.sections[1].children[0]).tag, "h4");
  assert.equal(asProse(page.sections[1].children[0]).text, "After");

  const specs = namedRangeSpecs(doc);
  assert.equal(
    specs.some((spec) => spec.startIndex === 1 && spec.endIndex === 20),
    false,
  );
  assert.ok(specs.some((spec) => spec.name.startsWith("pg/node/") && spec.endIndex === 66));
  assert.equal(specs.some((spec) => spec.name === "pg/meta"), false);

  const leading = parseDocument({
    body: { content: [para("---"), para("After\n")] },
  });
  assert.equal(leading.sections.length, 2);
  assert.deepEqual(leading.sections[0].children, []);
  assert.equal(asProse(leading.sections[1].children[0]).text, "After");

  const trailing = parseDocument({
    body: { content: [para("Hello\n", { style: "HEADING_1" }), para("---\n")] },
  });
  assert.equal(trailing.sections.length, 2);
  assert.equal(trailing.sections[1].children.length, 0);
});

test("aboutFixture and blankPage build the page model", () => {
  const about = aboutFixture();
  assert.equal(about.fileId, "about");
  assert.equal(about.revisionId, "r1");
  assert.equal(about.path, "about");
  assert.deepEqual(about.metadata, {
    title: "About",
    description: "What the studio ships.",
  });
  assert.equal(about.sections.length, 3);
  assert.equal(asProse(about.sections[0].children[0]).text, "About the studio");
  assert.equal(asProse(about.sections[0].children[0]).tag, "h1");
  assert.equal(asProse(about.sections[0].children[1]).text, "A one-paragraph introduction.");
  const hero = asBlock(about.sections[1].children[0]);
  assert.equal(hero.name, "hero");
  assert.deepEqual(hero.options, []);
  assert.equal(hero.rows.length, 2);
  assert.equal(hero.rows[0][0].children[0].text, "The work, plainly described.");
  assert.deepEqual(hero.rows[1][0].children[0].image, { driveFileId: "sample-studio", alt: "Studio" });
  const columns = asBlock(about.sections[2].children[0]);
  assert.equal(columns.name, "columns");
  assert.deepEqual(columns.options, ["contained"]);
  assert.equal(columns.rows.length, 1);
  assert.equal(columns.rows[0].length, 2);
  assert.deepEqual(
    columns.rows[0][0].children.map((item) => item.text),
    ["Left column", "First point."],
  );
  assert.deepEqual(
    columns.rows[0][1].children.map((item) => item.text),
    ["Right column", "Second point."],
  );
  for (const section of about.sections) {
    assert.equal(isSafeId(section.id), true);
    for (const child of section.children) {
      assert.equal(isSafeId(child.id), true);
      if (child.kind !== "block") continue;
      for (const row of child.rows) {
        for (const item of row) {
          assert.equal(isSafeId(item.id), true);
          for (const prose of item.children) assert.equal(isSafeId(prose.id), true);
        }
      }
    }
  }

  const blank = blankPage("Hello, World!");
  assert.equal(blank.path, "hello-world");
  assert.equal(blank.revisionId, "r1");
  assert.equal(blank.metadata.title, "Hello, World!");
  assert.match(blank.fileId, /^page_[a-z0-9]+$/);
  assert.equal(blank.sections.length, 1);
  assert.equal(asProse(blank.sections[0].children[0]).tag, "h1");
  assert.equal(asProse(blank.sections[0].children[0]).text, "Hello, World!");
  assert.equal(asProse(blank.sections[0].children[1]).tag, "p");
  assert.equal(asProse(blank.sections[0].children[1]).text, "");
  assert.equal(blankPage("***").path, "page");
  assert.equal(blankPage("  ").path, "page");
  assert.equal(blankPage("Page 2").path, "page-2");

  const html = renderPublishHtml(about);
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<title>About<\/title>/);
  assert.match(html, /<meta name="description" content="What the studio ships\.">/);
  assert.match(html, /<main>/);
  assert.match(html, /#f4f0e6/);
  assert.match(html, /#1c1915/);
  assert.match(html, /40rem/);
  assert.match(html, /max-width:\s*100%/);
  assert.match(html, /serif/);
  assert.equal(html.includes("contenteditable"), false);
  assert.ok(html.includes("About the studio"));
  assert.ok(html.includes("A one-paragraph introduction."));
  assert.ok(html.includes('class="hero"'));
  assert.ok(html.includes('src="/api/media/sample-studio"'));
  assert.ok(html.includes('alt="Studio"'));
  assert.ok(html.includes('class="columns contained"'));
  assert.ok(html.includes("Left column"));
  assert.ok(html.includes("First point."));
  assert.ok(html.includes("Right column"));
  assert.ok(html.includes("Second point."));
  assert.equal((html.match(/class="section"/g) ?? []).length, 3);

  const fromHeading = renderPublishHtml({
    fileId: "f",
    revisionId: "r1",
    path: "fallback",
    metadata: {},
    sections: [
      {
        id: "s",
        style: [],
        children: [{ kind: "prose", id: "h", tag: "h1", text: "From the heading" }],
      },
    ],
  });
  assert.match(fromHeading, /<title>From the heading<\/title>/);
  assert.equal(fromHeading.includes('name="description"'), false);
});

test("presentation rows in the Doc metadata table are ignored (#56)", () => {
  const page = parseDocument(studioDoc());
  assert.equal(page.metadata.title, "About");
  assert.equal("template" in page.metadata, false);
  assert.equal("Theme" in page.metadata, false);
});
