/**
 * Performance budgets for first-party themes (#58).
 *
 *   npm run budgets               byte budgets for every theme and fixture page
 *   npm run budgets:lighthouse    byte budgets, then Lighthouse (3 runs, median)
 *
 * Exits 1 with one line per breach naming the theme, the page and the budget.
 * Lighthouse runs against the rendered pages served locally with their CSP,
 * using Playwright's Chromium (CHROME_PATH overrides it).
 */
import { createServer, type Server } from "node:http";
import { readdirSync } from "node:fs";
import path from "node:path";
import { budgetsFor, checkBudgets, measure, shipsJs } from "@/lib/theme/budgets";
import { nodeOptimizer, publishedCsp } from "@/lib/theme/csp";
import { planImages, encodeMissing } from "@/lib/publish/images";
import { renderPage, type PublishAsset, type RenderResult } from "@/lib/theme/engine";
import { themeFixtures } from "@/lib/theme/fixtures";
import { loadThemeFromDir } from "@/lib/theme/package";

export const LIGHTHOUSE_BUDGETS = {
  performance: 95,
  accessibility: 95,
  lcpMs: 1800,
  cls: 0.05,
  /**
   * Enforced only on pages that ship JavaScript. On a page with none, TBT is
   * the runner's own style and layout jitter (CI saw 51 to 72 ms on 0 B JS).
   */
  tbtMs: 50,
};


type Rendered = { theme: string; fixture: string; result: RenderResult; images: PublishAsset[]; budgets: ReturnType<typeof budgetsFor> };

/** Fixture images are 1600×1000 photos-in-size; each id gets distinct bytes. */
async function fixtureImage(id: string) {
  const { default: sharp } = await import("sharp");
  let hue = 0;
  for (const ch of id) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const bytes = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: `hsl(${hue}, 40%, 55%)` } })
    .jpeg()
    .toBuffer();
  return { mime: "image/jpeg", bytes: new Uint8Array(bytes) };
}

async function renderAll(): Promise<Rendered[]> {
  const root = path.join(process.cwd(), "themes");
  const out: Rendered[] = [];
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const theme = loadThemeFromDir(path.join(root, dir.name));
    const budgets = budgetsFor(theme.manifest);
    for (const fixture of themeFixtures(theme.manifest)) {
      // Images go through the publish pipeline (#61), as on a real site.
      const plan = await planImages(fixture.page, fixtureImage);
      const result = renderPage(fixture.page, theme, { mode: "publish", csp: publishedCsp, optimizer: nodeOptimizer, images: plan.images });
      const { assets: images } = await encodeMissing(plan.planned, () => false);
      out.push({ theme: theme.manifest.name, fixture: fixture.name, result, images, budgets });
    }
  }
  return out;
}

function byteBudgets(pages: Rendered[]): string[] {
  const failures: string[] = [];
  for (const { theme, fixture, result, budgets } of pages) {
    const measured = measure(result, nodeOptimizer.gzipSize);
    const breaches = checkBudgets(measured, budgets);
    console.log(
      `${theme} ${fixture}: html ${measured.htmlKb} B, critical CSS ${measured.criticalCssKb} B, total CSS ${measured.totalCssKb} B, JS ${measured.jsKb} B, fonts ${measured.preloadedFonts}`,
    );
    for (const breach of breaches) {
      failures.push(`${theme} page "${fixture}": ${breach.label} is ${breach.actual} ${breach.unit}, over the budget of ${breach.limit}`);
    }
  }
  return failures;
}

function serve(pages: Rendered[]): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const page = pages.find(({ theme, fixture }) => url.pathname === `/${encodeURIComponent(theme)}/${fixture}`);
    if (page) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": page.result.csp });
      response.end(page.result.html);
      return;
    }
    for (const { result, images } of pages) {
      const asset = [...result.assets, ...images].find((candidate) => `/${candidate.path}` === url.pathname);
      if (asset) {
        response.writeHead(200, { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable" });
        response.end(asset.body);
        return;
      }
    }
    response.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, origin: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}` });
    });
  });
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function lighthouseBudgets(pages: Rendered[], runs: number): Promise<string[]> {
  const { default: lighthouse } = await import("lighthouse");
  const { chromium } = await import("@playwright/test");
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: [`--remote-debugging-port=${port}`],
  });
  const { server, origin } = await serve(pages);
  const failures: string[] = [];
  try {
    for (const { theme, fixture, result } of pages) {
      const samples: { performance: number; accessibility: number; lcpMs: number; cls: number; tbtMs: number }[] = [];
      for (let run = 0; run < runs; run++) {
        const result = await lighthouse(`${origin}/${encodeURIComponent(theme)}/${fixture}`, {
          port,
          output: "json",
          logLevel: "error",
          onlyCategories: ["performance", "accessibility"],
        });
        const lhr = result?.lhr;
        if (!lhr) throw new Error(`Lighthouse returned no result for ${theme} ${fixture}`);
        if (lhr.runtimeError) throw new Error(`Lighthouse failed on ${theme} ${fixture}: ${lhr.runtimeError.message}`);
        samples.push({
          performance: Math.round((lhr.categories.performance.score ?? 0) * 100),
          accessibility: Math.round((lhr.categories.accessibility.score ?? 0) * 100),
          lcpMs: lhr.audits["largest-contentful-paint"].numericValue ?? Infinity,
          cls: lhr.audits["cumulative-layout-shift"].numericValue ?? Infinity,
          tbtMs: lhr.audits["total-blocking-time"].numericValue ?? Infinity,
        });
      }
      const m = {
        performance: median(samples.map((s) => s.performance)),
        accessibility: median(samples.map((s) => s.accessibility)),
        lcpMs: median(samples.map((s) => s.lcpMs)),
        cls: median(samples.map((s) => s.cls)),
        tbtMs: median(samples.map((s) => s.tbtMs)),
      };
      console.log(
        `${theme} ${fixture}: performance ${m.performance}, accessibility ${m.accessibility}, LCP ${Math.round(m.lcpMs)} ms, CLS ${m.cls.toFixed(3)}, TBT ${Math.round(m.tbtMs)} ms${shipsJs(result) ? "" : " (no JS, not enforced)"} (median of ${runs})`,
      );
      const page = `${theme} page "${fixture}"`;
      if (m.performance < LIGHTHOUSE_BUDGETS.performance) failures.push(`${page}: Lighthouse performance is ${m.performance}, under ${LIGHTHOUSE_BUDGETS.performance}`);
      if (m.accessibility < LIGHTHOUSE_BUDGETS.accessibility) failures.push(`${page}: Lighthouse accessibility is ${m.accessibility}, under ${LIGHTHOUSE_BUDGETS.accessibility}`);
      if (m.lcpMs > LIGHTHOUSE_BUDGETS.lcpMs) failures.push(`${page}: LCP is ${Math.round(m.lcpMs)} ms, over ${LIGHTHOUSE_BUDGETS.lcpMs} ms`);
      if (m.cls > LIGHTHOUSE_BUDGETS.cls) failures.push(`${page}: CLS is ${m.cls.toFixed(3)}, over ${LIGHTHOUSE_BUDGETS.cls}`);
      if (shipsJs(result) && m.tbtMs > LIGHTHOUSE_BUDGETS.tbtMs) failures.push(`${page}: TBT is ${Math.round(m.tbtMs)} ms, over ${LIGHTHOUSE_BUDGETS.tbtMs} ms`);
    }
  } finally {
    server.close();
    await browser.close();
  }
  return failures;
}

async function main() {
  const pages = await renderAll();
  const failures = byteBudgets(pages);
  if (process.argv.includes("--lighthouse")) {
    const runs = Number(process.env.LIGHTHOUSE_RUNS ?? 3);
    failures.push(...(await lighthouseBudgets(pages, runs)));
  }
  if (failures.length) {
    console.error(`\n${failures.length} budget breach${failures.length === 1 ? "" : "es"}:`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log("\nAll theme budgets met.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
