import { describe, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { comparePngs, screenshot, visualDiff, visualDiffConfigured } from "./visual-diff";

const png = (width: number, height: number, color: { r: number; g: number; b: number }) =>
  sharp({ create: { width, height, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer().then((b) => new Uint8Array(b));

const white = { r: 255, g: 255, b: 255 };

describe("visual diff (#66)", () => {
  test("identical images do not differ; a recoloured half differs by half", async () => {
    const a = await png(1280, 400, white);
    assert.equal(await comparePngs(a, a), 0);
    const half = new Uint8Array(
      await sharp(a)
        .composite([{ input: await sharp({ create: { width: 640, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer(), left: 0, top: 0 }])
        .png()
        .toBuffer(),
    );
    assert.ok(Math.abs((await comparePngs(a, half)) - 0.5) < 0.01);
  });

  test("a longer page is compared against white padding, and small colour noise is ignored", async () => {
    assert.ok(Math.abs((await comparePngs(await png(1280, 400, white), await png(1280, 800, { r: 0, g: 0, b: 0 }))) - 1) < 0.01);
    assert.equal(await comparePngs(await png(1280, 400, white), await png(1280, 400, { r: 250, g: 250, b: 250 })), 0);
    assert.ok(Math.abs((await comparePngs(await png(1280, 400, white), await png(1280, 800, white))) - 0) < 0.01);
  });

  test("screenshots go to Cloudflare Browser Run with the configured token", async () => {
    assert.equal(visualDiffConfigured(), false);
    await assert.rejects(screenshot("<p>x</p>"), /not configured/);
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.CLOUDFLARE_BROWSER_TOKEN = "tok";
    try {
      const calls: { url: string; init: RequestInit }[] = [];
      const image = await png(1280, 100, white);
      const fetcher = (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(image, { status: 200, headers: { "Content-Type": "image/png" } });
      }) as unknown as typeof fetch;
      assert.equal(await visualDiff("<p>a</p>", "<p>b</p>", fetcher), 0);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.url, "https://api.cloudflare.com/client/v4/accounts/acct/browser-run/screenshot");
      assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer tok");
      assert.equal(JSON.parse(String(calls[0]!.init.body)).html, "<p>a</p>");
      const failing = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
      await assert.rejects(screenshot("<p>x</p>", failing), /Screenshot failed \(403\)/);
    } finally {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      delete process.env.CLOUDFLARE_BROWSER_TOKEN;
    }
  });
});
