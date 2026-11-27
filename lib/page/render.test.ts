import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { renderPageHtml, renderPublishHtml } from "./render";
import type { Block, Page, Prose } from "./types";

const HOSTILE = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)`,
  `</title><script>alert(1)</script>`,
  `</style><script>alert(1)</script>`,
  `javascript:alert(1)`,
  `<a href="javascript:alert(1)">x</a>`,
  `<svg onload=alert(1)>`,
  `<iframe src="https://evil.example"></iframe>`,
];

function prose(text: string, tag: Prose["tag"] = "p"): Prose {
  return { kind: "prose", id: "n", tag, text };
}

function hostilePage(payload: string): Page {
  const block: Block = {
    kind: "block",
    id: "b",
    name: `hero ${payload}`,
    options: [payload],
    rows: [[{ id: "c", children: [prose(payload, "h1"), { kind: "prose", id: "l", tag: "ul", items: [payload] }] }]],
  };
  return {
    fileId: "f",
    revisionId: "r1",
    path: payload,
    metadata: { title: payload, description: payload, image: payload },
    sections: [
      {
        id: "s",
        style: [payload],
        children: [
          prose(payload, "h2"),
          prose(payload),
          { kind: "prose", id: "o", tag: "ol", items: [payload, payload] },
          { kind: "prose", id: "i", tag: "img", image: { driveFileId: payload, alt: payload } },
          block,
        ],
      },
    ],
  };
}

/** Everything a browser would treat as markup: tags and attribute names. */
function tagsIn(html: string): string[] {
  return [...html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g)].map((m) => `${m[1].toLowerCase()}${m[2]}`);
}

const ALLOWED_TAGS = new Set(["html", "head", "meta", "title", "style", "body", "main", "div", "h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "img"]);

describe("renderPublishHtml with hostile Doc content", () => {
  for (const payload of HOSTILE) {
    test(`neutralises ${JSON.stringify(payload)}`, () => {
      const html = renderPublishHtml(hostilePage(payload));
      for (const tag of tagsIn(html.replace(/^<!DOCTYPE html>/, ""))) {
        const name = tag.split(/[\s/]/)[0];
        assert.ok(ALLOWED_TAGS.has(name), `unexpected <${tag}>`);
        // Every attribute value is double-quoted; what is left are attribute names.
        const names = tag.replace(/="[^"]*"/g, "");
        assert.doesNotMatch(names, /['=]/, `unquoted attribute in <${tag}>`);
        assert.doesNotMatch(names, /\son[a-z]+/i, `event handler in <${tag}>`);
        assert.doesNotMatch(tag, /(href|src)\s*=\s*["']?\s*javascript:/i, `javascript: URL in <${tag}>`);
      }
      assert.equal((html.match(/<script/gi) ?? []).length, 0);
      // Two style elements: the tokens and the page CSS (#57).
      assert.equal((html.match(/<\/style>/g) ?? []).length, 2, "the stylesheet cannot be closed early");
      assert.equal((html.match(/<\/title>/g) ?? []).length, 1, "the title cannot be closed early");
    });
  }

  test("keeps every image under /api/media", () => {
    const html = renderPublishHtml(hostilePage(`https://evil.example/x.png`));
    for (const match of html.matchAll(/<img src="([^"]*)"/g)) {
      assert.ok(match[1].startsWith("/api/media/"), match[1]);
    }
  });
});

describe("published page CSP", () => {
  const { html, csp } = renderPageHtml(hostilePage("x"));

  test("allows no script and only the page's own stylesheet", () => {
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  });

  test("the style hash matches the <style> element the page contains", () => {
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    const hash = createHash("sha256").update(style).digest("base64");
    assert.ok(csp.includes(`'sha256-${hash}'`));
  });

  test("is written into the page as a meta tag", () => {
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${csp}">`));
  });
});
