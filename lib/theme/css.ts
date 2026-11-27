/**
 * CSS handling for the theme engine (#59). Browser-safe: no Node imports.
 *
 * Themes ship small hand-written CSS, so this is a careful whitespace and
 * comment minifier plus a top-level rule splitter, not a full CSS parser.
 * Strings and url() contents are kept byte for byte.
 */

/** Removes comments and collapses whitespace outside strings. */
export function minifyCss(css: string): string {
  let out = "";
  let i = 0;
  let pendingSpace = false;
  // A space can go before these, or after the second set, without changing meaning.
  // "+", "-" and parentheses are left alone: calc() and media queries need their spaces.
  const before = new Set(["{", "}", ";", ",", ">"]);
  const after = new Set(["{", "}", ";", ",", ">", ":"]);
  while (i < css.length) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      pendingSpace = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === "\\" ? 2 : 1;
      if (pendingSpace && out && !after.has(out[out.length - 1])) out += " ";
      pendingSpace = false;
      out += css.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pendingSpace = true;
      i++;
      continue;
    }
    if (pendingSpace && out && !before.has(ch) && !after.has(out[out.length - 1])) out += " ";
    pendingSpace = false;
    out += ch;
    i++;
  }
  return out.replace(/;}/g, "}");
}

type Rule = { prelude: string; body: string };

/** Splits minified CSS into top-level rules. Returns null if braces do not balance. */
function splitRules(css: string): Rule[] | null {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open === -1) {
      // A trailing at-statement such as @import x; is kept as a prelude-only rule.
      const rest = css.slice(i).trim();
      if (rest) rules.push({ prelude: rest, body: "" });
      break;
    }
    const semicolon = css.indexOf(";", i);
    if (semicolon !== -1 && semicolon < open) {
      rules.push({ prelude: css.slice(i, semicolon + 1), body: "" });
      i = semicolon + 1;
      continue;
    }
    let depth = 0;
    let j = open;
    for (; j < css.length; j++) {
      const ch = css[j];
      if (ch === '"' || ch === "'") {
        let k = j + 1;
        while (k < css.length && css[k] !== ch) k += css[k] === "\\" ? 2 : 1;
        j = k;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) return null;
    rules.push({ prelude: css.slice(i, open), body: css.slice(open + 1, j) });
    i = j + 1;
  }
  return rules;
}

function splitSelectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < prelude.length; i++) {
    const ch = prelude[i];
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  out.push(prelude.slice(start));
  return out;
}

/**
 * Drops selectors that need a block option the page does not use, e.g.
 * `.columns.contained` when no columns block on the page is "contained".
 * `unused` maps a block name to its declared options that are absent.
 */
export function pruneUnusedOptions(css: string, unused: Record<string, string[]>): string {
  const patterns = Object.entries(unused).flatMap(([block, options]) =>
    options.map((option) => new RegExp(`\\.${escapeRegExp(block)}\\.${escapeRegExp(option)}(?![\\w-])|\\.${escapeRegExp(option)}\\.${escapeRegExp(block)}(?![\\w-])`)),
  );
  if (patterns.length === 0) return css;
  const rules = splitRules(css);
  if (!rules) return css;
  return rules
    .map(({ prelude, body }) => {
      if (!body && !prelude.includes("{")) return prelude;
      if (prelude.startsWith("@media") || prelude.startsWith("@supports") || prelude.startsWith("@layer")) {
        const inner = pruneUnusedOptions(body, unused);
        return inner ? `${prelude}{${inner}}` : "";
      }
      if (prelude.startsWith("@")) return `${prelude}{${body}}`;
      const kept = splitSelectors(prelude).filter((selector) => !patterns.some((pattern) => pattern.test(selector)));
      return kept.length ? `${kept.join(",")}{${body}}` : "";
    })
    .join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The critical-CSS budget from the theme ADR: 10 KB compressed. */
export const CRITICAL_CSS_BUDGET_BYTES = 10 * 1024;
