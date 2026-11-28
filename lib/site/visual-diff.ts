import sharp, { type Metadata } from "sharp";

/**
 * Pixel diffs for theme change previews (#66). Both renders are screenshotted
 * by Cloudflare Browser Run from their HTML, then compared here. Optional:
 * without CLOUDFLARE_BROWSER_TOKEN, previews compare markup only.
 *
 * CLOUDFLARE_ACCOUNT_ID: the account that runs the browser.
 * CLOUDFLARE_BROWSER_TOKEN: an API token with "Browser Rendering - Edit" only.
 *
 * The screenshot sees the page's inline critical CSS; deferred stylesheets and
 * images on this app's preview paths are not reachable from Cloudflare, so the
 * diff covers layout, type and colour above all.
 */

const VIEWPORT = { width: 1280, height: 900 };
/** A pixel counts as changed when any channel moves by more than this, which ignores anti-aliasing noise. */
const CHANNEL_THRESHOLD = 32;
/** Pages longer than this are compared over their first part only. */
const MAX_HEIGHT = 6000;

export function visualDiffConfigured(): boolean {
  return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID?.trim() && process.env.CLOUDFLARE_BROWSER_TOKEN?.trim());
}

/** A full-page PNG of the HTML. */
export async function screenshot(html: string, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = process.env.CLOUDFLARE_BROWSER_TOKEN?.trim();
  if (!account || !token) throw new Error("Screenshots are not configured");
  const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/browser-run/screenshot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ html, viewport: VIEWPORT, screenshotOptions: { fullPage: true, type: "png" } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Screenshot failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function rgba(png: Uint8Array, width: number, height: number): Promise<Buffer> {
  const image = sharp(png).ensureAlpha();
  const meta = await image.metadata();
  const scaled = meta.width && meta.width !== width ? image.resize({ width }) : image;
  const resized = await scaled.png().toBuffer();
  const info = await sharp(resized).metadata();
  const own = Math.min(info.height ?? 0, height);
  return sharp(resized)
    .extract({ left: 0, top: 0, width, height: own })
    .extend({ bottom: height - own, background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/** The share of pixels (0 to 1) that differ between two PNGs, over the taller page, padded with white. */
export async function comparePngs(a: Uint8Array, b: Uint8Array): Promise<number> {
  const [ma, mb] = await Promise.all([sharp(a).metadata(), sharp(b).metadata()]);
  const width = VIEWPORT.width;
  const heightOf = (meta: Metadata) => Math.round(((meta.height ?? 0) * width) / (meta.width || width));
  const height = Math.max(1, Math.min(MAX_HEIGHT, Math.max(heightOf(ma), heightOf(mb))));
  const [x, y] = await Promise.all([rgba(a, width, height), rgba(b, width, height)]);
  let changed = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (
      Math.abs(x[i]! - y[i]!) > CHANNEL_THRESHOLD ||
      Math.abs(x[i + 1]! - y[i + 1]!) > CHANNEL_THRESHOLD ||
      Math.abs(x[i + 2]! - y[i + 2]!) > CHANNEL_THRESHOLD
    ) {
      changed += 1;
    }
  }
  return changed / (width * height);
}

/** Screenshots both renders and compares them. */
export async function visualDiff(liveHtml: string, candidateHtml: string, fetcher: typeof fetch = fetch): Promise<number> {
  const [a, b] = await Promise.all([screenshot(liveHtml, fetcher), screenshot(candidateHtml, fetcher)]);
  return comparePngs(a, b);
}
