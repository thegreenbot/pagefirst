import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { aboutFixture } from "@/lib/page/fixture";
import { nodeOptimizer, publishedCsp } from "./csp";
import { renderPage } from "./engine";
import { beaconScript } from "./beacon";
import { getDefaultTheme } from "./package";

const beacon = { endpoint: "https://app.example.com/api/vitals", site: "site_1", path: "/about" };
const hash = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

describe("speed beacon (#70)", () => {
  test("a page without the beacon ships no script", () => {
    const { html, csp } = renderPage(aboutFixture(), getDefaultTheme(), { csp: publishedCsp, optimizer: nodeOptimizer });
    assert.ok(!html.includes("<script"));
    assert.match(csp, /script-src 'none'/);
    assert.ok(!csp.includes("connect-src"));
  });

  test("the beacon is inline, hashed in the CSP, and allowed to post only to the collector's origin", () => {
    const { html, csp } = renderPage(aboutFixture(), getDefaultTheme(), { csp: publishedCsp, optimizer: nodeOptimizer, beacon });
    const script = beaconScript(beacon);
    assert.ok(html.includes(`<script>${script}</script>`));
    assert.ok(csp.includes(`script-src 'self' ${hash(script)}`) || csp.includes(hash(script)));
    assert.match(csp, /connect-src https:\/\/app\.example\.com(;|$)/);
  });

  test("the editor never ships the beacon", () => {
    const { html } = renderPage(aboutFixture(), getDefaultTheme(), { mode: "edit", beacon });
    assert.ok(!html.includes("sendBeacon"));
  });

  test("values embedded in the script cannot close it", () => {
    const script = beaconScript({ ...beacon, path: "/</script><b> " });
    assert.ok(!script.includes("</script>"));
    assert.ok(!script.includes(" "));
  });

  test("the script stays small", () => {
    assert.ok(beaconScript(beacon).length < 1200);
  });
});
