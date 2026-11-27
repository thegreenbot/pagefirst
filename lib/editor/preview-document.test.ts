import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aboutFixture } from "@/lib/page/fixture";
import { renderPage } from "@/lib/theme/engine";
import { getDefaultTheme } from "@/lib/theme/package";
import { PREVIEW_SANDBOX, deferMedia, isMediaPath, parseFromPreview, previewCsp, previewDocument } from "./preview-document";

describe("preview document", () => {
  const edit = renderPage(aboutFixture(), getDefaultTheme(), { mode: "edit" }).html;
  const doc = previewDocument(edit, "abc123");

  test("the frame never gets the app's origin", () => {
    assert.equal(PREVIEW_SANDBOX.split(/\s+/).includes("allow-same-origin"), false);
    assert.ok(PREVIEW_SANDBOX.includes("allow-scripts"));
  });

  test("adds a CSP and a bridge script carrying the editor page's nonce", () => {
    assert.ok(doc.includes(`<meta http-equiv="Content-Security-Policy" content="${previewCsp("abc123")}">`));
    assert.match(previewCsp("abc123"), /script-src 'nonce-abc123'/);
    assert.doesNotMatch(previewCsp("abc123"), /unsafe-eval|'self'.*script/);
    assert.equal((doc.match(/<script nonce="abc123">/g) ?? []).length, 1);
    assert.ok(doc.indexOf("<script nonce") < doc.indexOf("</body>"));
  });

  test("keeps the theme's markup and defers media to the bridge", () => {
    assert.ok(doc.includes('<div class="hero" data-pf-id='));
    assert.doesNotMatch(doc, /\ssrc="\/api\/media\//);
    assert.ok(doc.includes('data-pf-src="/api/media/sample-studio"'));
    assert.equal(deferMedia('<img src="https://x.example/a.png">'), '<img src="https://x.example/a.png">');
  });

  test("a hostile nonce cannot break out of the attribute", () => {
    const hostile = previewDocument(edit, `"><script>alert(1)</script>`);
    assert.equal(hostile.includes(`"><script>alert(1)`), false);
  });

  test("wraps a fragment without head or body", () => {
    const fragment = previewDocument("<p>x</p>", "n");
    assert.ok(fragment.startsWith("<meta"));
    assert.ok(fragment.endsWith("</script>"));
  });
});

describe("messages from the preview", () => {
  test("accepts well-formed messages", () => {
    assert.deepEqual(parseFromPreview({ pf: 1, type: "ready" }), { pf: 1, type: "ready" });
    assert.deepEqual(parseFromPreview({ pf: 1, type: "select", id: "n_1" }), { pf: 1, type: "select", id: "n_1" });
    assert.deepEqual(parseFromPreview({ pf: 1, type: "text", id: "n_1", text: "Hi" }), { pf: 1, type: "text", id: "n_1", text: "Hi" });
    assert.deepEqual(parseFromPreview({ pf: 1, type: "height", height: 1e9 }), { pf: 1, type: "height", height: 100_000 });
    assert.deepEqual(parseFromPreview({ pf: 1, type: "image", src: "/api/media/m_1" }), { pf: 1, type: "image", src: "/api/media/m_1" });
  });

  test("rejects anything else", () => {
    for (const data of [
      null,
      "ready",
      { type: "ready" },
      { pf: 1, type: "nope" },
      { pf: 1, type: "select", id: 3 },
      { pf: 1, type: "select", id: "x".repeat(201) },
      { pf: 1, type: "text", id: "n", text: "x".repeat(20_001) },
      { pf: 1, type: "height", height: Number.NaN },
      { pf: 1, type: "image", src: "https://evil.example/x" },
      { pf: 1, type: "image", src: "/api/media/../auth/logout" },
      { pf: 1, type: "image", src: "/api/pages/about" },
    ]) {
      assert.equal(parseFromPreview(data), null, JSON.stringify(data));
    }
    assert.equal(isMediaPath("/api/media/ok_id-1"), true);
  });
});
