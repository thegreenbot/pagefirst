import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, overrideConflicts } from "./diff";

describe("template diffs", () => {
  test("equal text has no diff", () => assert.equal(lineDiff("a\nb", "a\nb"), ""));

  test("shows added and removed lines in context", () => {
    assert.equal(lineDiff("<footer>\n<p>old</p>\n</footer>", "<footer>\n<p>new</p>\n<nav></nav>\n</footer>"), " <footer>\n-<p>old</p>\n+<p>new</p>\n+<nav></nav>\n </footer>");
  });

  test("reports only overridden templates whose original changed or went away", () => {
    const overrides = { "partials/footer": "mine", "partials/header": "mine", "partials/gone": "mine", "partials/new": "mine" };
    const from = { "partials/footer": "a", "partials/header": "same", "partials/gone": "x" };
    const to = { "partials/footer": "b", "partials/header": "same" };
    const found = overrideConflicts(overrides, from, to);
    assert.deepEqual(found.map((c) => [c.path, c.status]), [["partials/footer", "changed"], ["partials/gone", "removed"]]);
    assert.match(found[0].diff, /-a\n\+b/);
  });
});
