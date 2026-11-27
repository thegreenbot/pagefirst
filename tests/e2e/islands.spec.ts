import { expect, test } from "@playwright/test";
import { publishedCsp, nodeOptimizer } from "../../lib/theme/csp";
import { renderPage } from "../../lib/theme/engine";
import { parseManifest } from "../../lib/theme/manifest";
import type { ThemePackage } from "../../lib/theme/package";
import type { Page as Doc } from "../../lib/page/types";

// A published page with a `visible` island fetches the island's module only when
// the block scrolls into view (#60). The page is rendered by the engine and
// served from an intercepted origin, with its real CSP as a header.
const ORIGIN = "https://site.test";

const theme: ThemePackage = {
  manifest: parseManifest({
    name: "@test/islands",
    version: "1.0.0",
    engine: 1,
    templates: { page: { label: "Page" } },
    blocks: { counter: { label: "Counter", js: { load: "visible" } }, spacer: { label: "Spacer" } },
  }),
  templates: {
    "layouts/page":
      "<!DOCTYPE html><html><head>{% pf_head %}</head><body>{% for s in page.sections %}{% for n in s.children %}{% pf_node n %}{% endfor %}{% endfor %}{% pf_foot %}</body></html>",
    "blocks/counter/block": '{% island %}<p class="counter">waiting</p>{% endisland %}',
    "blocks/spacer/block": '<div class="spacer"></div>',
  },
  baseCss: ".spacer{height:3000px}",
  blockCss: {},
  blockJs: { counter: 'export default (el) => { el.querySelector(".counter").textContent = "mounted"; };' },
  tokens: {},
};

const doc: Doc = {
  fileId: "f",
  revisionId: "r",
  path: "p",
  metadata: { title: "Islands" },
  sections: [
    { id: "s1", style: [], children: [{ kind: "block", id: "a", name: "spacer", options: [], rows: [] }] },
    { id: "s2", style: [], children: [{ kind: "block", id: "b", name: "counter", options: [], rows: [] }] },
  ],
};

test("a visible island downloads its module only when it scrolls into view", async ({ page }) => {
  const { html, csp, assets } = renderPage(doc, theme, { csp: publishedCsp, optimizer: nodeOptimizer });
  const moduleAsset = assets.find((asset) => asset.path.endsWith(".js"));
  expect(moduleAsset).toBeTruthy();

  const fetched: string[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/") {
      await route.fulfill({ body: html, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp } });
      return;
    }
    const asset = assets.find((candidate) => `/${candidate.path}` === url.pathname);
    if (!asset) return route.fulfill({ status: 404, body: "" });
    fetched.push(url.pathname);
    await route.fulfill({ body: typeof asset.body === "string" ? asset.body : Buffer.from(asset.body), headers: { "Content-Type": asset.contentType } });
  });
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(`${ORIGIN}/`);
  await page.waitForLoadState("load");
  await page.waitForTimeout(300);
  expect(fetched).toEqual([]);
  await expect(page.locator(".counter")).toHaveText("waiting");

  await page.locator(".counter").scrollIntoViewIfNeeded();
  await expect(page.locator(".counter")).toHaveText("mounted");
  expect(fetched).toEqual([`/${moduleAsset!.path}`]);
  expect(errors).toEqual([]);
});
