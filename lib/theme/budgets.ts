import type { RenderResult } from "./engine";
import type { ThemeManifest } from "./manifest";

/**
 * Byte budgets for a rendered page (#58), from the theme ADR. A theme's
 * manifest can only tighten them (theme.schema.json caps each value at these
 * defaults). Cheap enough for publish to run too; Lighthouse budgets live in
 * scripts/theme-budgets.ts.
 */

export type BudgetName = "htmlKb" | "criticalCssKb" | "totalCssKb" | "jsKb" | "fontKb" | "preloadedFonts";

export const DEFAULT_BUDGETS: Record<BudgetName, number> = {
  htmlKb: 14,
  criticalCssKb: 10,
  totalCssKb: 30,
  jsKb: 15,
  fontKb: 60,
  preloadedFonts: 2,
};

export const BUDGET_LABELS: Record<BudgetName, string> = {
  htmlKb: "HTML plus inlined CSS, compressed",
  criticalCssKb: "Critical CSS, compressed",
  totalCssKb: "Total CSS per page, compressed",
  jsKb: "JS per page, compressed",
  fontKb: "Preloaded fonts, bytes",
  preloadedFonts: "Preloaded font files",
};

export type Measurement = Record<BudgetName, number>;
export type Breach = { budget: BudgetName; label: string; actual: number; limit: number; unit: "bytes" | "files" };

export function budgetsFor(manifest: Pick<ThemeManifest, "budgets" | "blocks">): Measurement {
  const out = { ...DEFAULT_BUDGETS };
  for (const name of Object.keys(DEFAULT_BUDGETS) as BudgetName[]) {
    const value = manifest.budgets?.[name];
    if (typeof value === "number" && value >= 0) out[name] = Math.min(out[name], value);
  }
  // A theme without island blocks ships no JS at all.
  if (!Object.values(manifest.blocks).some((block) => block.js)) out.jsKb = 0;
  return out;
}

/** Text of each <style> or <script> element in engine output, found by plain string search. */
function elementText(html: string, tag: "style" | "script"): string[] {
  const out: string[] = [];
  const close = `</${tag}>`;
  let at = 0;
  for (;;) {
    const open = html.indexOf(`<${tag}`, at);
    if (open === -1) break;
    const next = html[open + tag.length + 1];
    const start = html.indexOf(">", open);
    const end = html.indexOf(close, start);
    if (start === -1 || end === -1) break;
    if (next === ">" || next === " ") out.push(html.slice(start + 1, end));
    at = end + close.length;
  }
  return out;
}

/** Sizes of a rendered page: compressed bytes for text, raw bytes and file count for fonts. */
export function measure(result: Pick<RenderResult, "html" | "assets">, gzipSize: (text: string) => number): Measurement {
  const inlineCss = elementText(result.html, "style").join("");
  const deferredCss = result.assets.filter((asset) => asset.contentType.startsWith("text/css")).map((asset) => asset.body).join("");
  const js = [
    ...elementText(result.html, "script"),
    ...result.assets.filter((asset) => asset.contentType.startsWith("text/javascript")).map((asset) => asset.body),
  ].join("");
  const preloads = [...result.html.matchAll(/<link\s[^>]*rel="preload"[^>]*as="font"[^>]*>/g)].map((match) => match[0]);
  const fontBytes = preloads.reduce((total, link) => {
    const href = /href="\/?([^"]+)"/.exec(link)?.[1];
    const asset = result.assets.find((candidate) => candidate.path === href);
    return total + (asset ? asset.body.length : 0);
  }, 0);
  return {
    htmlKb: gzipSize(result.html),
    criticalCssKb: inlineCss ? gzipSize(inlineCss) : 0,
    totalCssKb: inlineCss || deferredCss ? gzipSize(inlineCss + deferredCss) : 0,
    jsKb: js ? gzipSize(js) : 0,
    fontKb: fontBytes,
    preloadedFonts: preloads.length,
  };
}

export function checkBudgets(measured: Measurement, budgets: Measurement): Breach[] {
  return (Object.keys(budgets) as BudgetName[]).flatMap((budget) => {
    const files = budget === "preloadedFonts";
    const limit = files ? budgets[budget] : Math.round(budgets[budget] * 1024);
    return measured[budget] > limit ? [{ budget, label: BUDGET_LABELS[budget], actual: measured[budget], limit, unit: files ? "files" as const : "bytes" as const }] : [];
  });
}
