import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { getDefaultTheme } from "./package";
import { isTokenValue, LAYER_ORDER, orphanTokens, resolveTokens, tokenDefs, tokensCss } from "./tokens";

const theme = {
  tokens: {
    "color-brand": { type: "color", value: "#1a4738", label: "Brand" },
    measure: { type: "size", value: "40rem" },
    "Bad Name": { type: "color", value: "red" },
    broken: { type: "color", value: "red;}body{display:none" },
    odd: { type: "mystery", value: 3 },
  },
};

describe("design tokens", () => {
  test("reads declared tokens and skips malformed ones", () => {
    const defs = tokenDefs(theme);
    assert.deepEqual(Object.keys(defs).sort(), ["color-brand", "measure", "odd"]);
    assert.equal(defs.measure.label, "measure");
    assert.equal(defs.odd.type, "other");
  });

  test("site values override defaults; undeclared and unsafe values are ignored", () => {
    const values = resolveTokens(theme, { "color-brand": "#000", measure: "1px}", extra: "x" });
    assert.deepEqual(values, { "color-brand": "#000", measure: "40rem", odd: 3 });
  });

  test("compiles to custom properties in the tokens layer", () => {
    const css = tokensCss({ "color-brand": "#000", odd: 3 });
    assert.equal(css, `${LAYER_ORDER}@layer tokens{:root{--pf-color-brand:#000;--pf-odd:3}}`);
  });

  test("never emits a value that could escape the declaration or the style element", () => {
    for (const value of ["a;b", "a}b", "</style>", "a\\b", "a\nb", Number.NaN]) {
      assert.equal(isTokenValue(value), false, String(value));
    }
    assert.equal(tokensCss({ x: "</style><script>" } as never).includes("<"), false);
  });

  test("reports site tokens the theme no longer declares", () => {
    assert.deepEqual(orphanTokens(theme, { measure: "1rem", gone: "x" }), ["gone"]);
  });

  test("the default theme's base CSS only uses tokens it declares", () => {
    const defaults = getDefaultTheme();
    const declared = new Set(Object.keys(tokenDefs(defaults)));
    const used = [...defaults.baseCss.matchAll(/var\(--pf-([a-z0-9-]+)/g)].map((match) => match[1]);
    assert.ok(used.length > 0);
    for (const name of used) assert.ok(declared.has(name), `--pf-${name} is not declared`);
  });
});
