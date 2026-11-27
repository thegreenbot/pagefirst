import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { closeDatabase } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import type { Page } from "@/lib/page/types";
import { renderPageHtml } from "@/lib/page/render";
import { siteForOwner } from "@/lib/site/theme-config";
import { encodeMissing, imageIds, planImages, recordSiteRenditions, siteHasRenditions, widthsFor } from "./images";

const png = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: "#3a6" } }).png().toBuffer().then((b) => new Uint8Array(b));

function withImages(ids: string[]): Page {
  const page = aboutFixture();
  page.sections[0].children.push(...ids.map((id) => ({ kind: "prose" as const, id: `n-${id}`, tag: "img" as const, image: { driveFileId: id, alt: `Alt ${id}` } })));
  return page;
}

describe("image renditions (#61)", () => {
  test("rendition widths stop at the image's own width", () => {
    assert.deepEqual(widthsFor(4000), [480, 960, 1440, 1920]);
    assert.deepEqual(widthsFor(1000), [480, 960, 1000]);
    assert.deepEqual(widthsFor(300), [300]);
  });

  test("finds images in prose and in blocks, once each", () => {
    assert.deepEqual(imageIds(withImages(["a", "sample-studio"])), ["a", "sample-studio"]);
  });

  test("plans renditions from the source bytes and encodes AVIF and WebP at each width", async () => {
    const bytes = await png(1000, 500);
    const plan = await planImages(withImages(["big"]), async (id) => (id === "big" ? { mime: "image/png", bytes } : null));
    const big = plan.planned.find((image) => image.driveFileId === "big")!;
    assert.equal(big.width, 1000);
    assert.equal(big.height, 500);
    assert.match(big.hash, /^[a-f0-9]{16}$/);
    assert.deepEqual(big.rendition.webp.map((r) => r.width), [480, 960, 1000]);
    assert.equal(big.rendition.avif[0].path, `assets/img/${big.hash}-480.avif`);
    assert.match(plan.warnings.join("\n"), /sample-studio was not found/);

    const assets = await big.encode();
    assert.equal(assets.length, 6);
    assert.strictEqual(await big.encode(), assets, "encoding is memoized");
    for (const asset of assets) {
      const meta = await sharp(asset.body as Uint8Array).metadata();
      const width = Number(/-(\d+)\./.exec(asset.path)![1]);
      assert.equal(meta.width, width, asset.path);
      assert.equal(meta.format === "heif" ? "image/avif" : `image/${meta.format}`, asset.contentType);
    }
  });

  test("the same bytes always get the same paths; other bytes get others", async () => {
    const a = await png(600, 400);
    const b = await png(600, 401);
    const first = await planImages(withImages(["x"]), async () => ({ mime: "image/png", bytes: a }));
    const again = await planImages(withImages(["y"]), async () => ({ mime: "image/png", bytes: a }));
    const other = await planImages(withImages(["x"]), async () => ({ mime: "image/png", bytes: b }));
    assert.deepEqual(first.planned[0].paths, again.planned[0].paths);
    assert.notDeepEqual(first.planned[0].paths, other.planned[0].paths);
  });

  test("EXIF rotation swaps the published dimensions", async () => {
    const rotated = new Uint8Array(await sharp({ create: { width: 800, height: 400, channels: 3, background: "#000" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer());
    const plan = await planImages(withImages(["r"]), async () => ({ mime: "image/jpeg", bytes: rotated }));
    assert.deepEqual([plan.planned[0].width, plan.planned[0].height], [400, 800]);
  });

  test("bytes that are not an image are reported, not published", async () => {
    const plan = await planImages(withImages(["bad"]), async () => ({ mime: "image/png", bytes: new TextEncoder().encode("not an image") }));
    assert.equal(plan.planned.length, 0);
    assert.match(plan.warnings.join("\n"), /bad could not be read/);
  });

  test("a destination that already has an image gets nothing encoded", async () => {
    const plan = await planImages(withImages(["x"]), async (id) => (id === "x" ? { mime: "image/png", bytes: await png(500, 300) } : null));
    assert.deepEqual(await encodeMissing(plan.planned, () => true), { assets: [], encoded: [] });
    assert.equal((await encodeMissing(plan.planned, () => false)).assets.length, 4);
  });

  test("published pages use renditions with dimensions and never /api/media", async () => {
    const plan = await planImages(withImages(["x"]), async (id) =>
      id === "x" ? { mime: "image/png", bytes: await png(1200, 800) } : { mime: "image/svg+xml", bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>') },
    );
    const { html, warnings } = renderPageHtml(withImages(["x", "missing"]), "publish", undefined, plan.images);
    assert.ok(!html.includes("/api/media"));
    const images = html.match(/<img [^>]*>/g) ?? [];
    assert.equal(images.length, 2);
    for (const img of images) assert.match(img, / width="\d+" height="\d+"/);
    assert.match(images[0], /fetchpriority="high"/);
    assert.match(images[1], /loading="lazy" decoding="async"/);
    assert.ok(html.includes('<source type="image/avif" srcset="/assets/img/'));
    assert.match(html, /srcset="[^"]*-480\.webp 480w, [^"]*-960\.webp 960w, [^"]*-1200\.webp 1200w"/);
    assert.match(warnings.join("\n"), /could not be prepared/);
  });
});

const url = testDatabaseUrl();

describe("renditions already on a site", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("republishing an unchanged page creates no new renditions", async () => {
    const site = await siteForOwner("image-owner");
    const other = await siteForOwner("someone-else");
    const plan = await planImages(withImages(["x"]), async (id) => (id === "x" ? { mime: "image/png", bytes: await png(700, 300) } : null));
    const hashes = plan.planned.map((image) => image.hash);

    const first = await encodeMissing(plan.planned, async (image) => (await siteHasRenditions(site, hashes)).has(image.hash));
    assert.equal(first.encoded.length, 1);
    await recordSiteRenditions(site, first.encoded);

    const again = await encodeMissing(plan.planned, async (image) => (await siteHasRenditions(site, hashes)).has(image.hash));
    assert.deepEqual(again, { assets: [], encoded: [] });
    // Another site has its own folder, so it still gets the files.
    assert.equal((await siteHasRenditions(other, hashes)).size, 0);
  });
});
