import { createHash } from "node:crypto";
import sharp, { type Sharp } from "sharp";
import { databaseConfigured, query } from "@/lib/db/client";
import { readMedia } from "@/lib/media";
import type { Page } from "@/lib/page/types";
import type { ImageRendition, PublishAsset } from "@/lib/theme/engine";

/**
 * Image renditions at publish time (#61). Each image's bytes are copied out of
 * the media store into content-addressed AVIF and WebP files at fixed widths,
 * so a published page never references /api/media or Drive. Paths depend only
 * on the source bytes, so a destination that already has an image's
 * renditions gets nothing encoded or uploaded again.
 */

/** Rendition widths; images narrower than the largest also get one at their own width. */
export const RENDITION_WIDTHS = [480, 960, 1440, 1920];
const FORMATS = [
  { ext: "avif", contentType: "image/avif", encode: (image: Sharp) => image.avif({ quality: 50, effort: 2 }) },
  { ext: "webp", contentType: "image/webp", encode: (image: Sharp) => image.webp({ quality: 75 }) },
] as const;
const MAX_INPUT_PIXELS = 50_000_000;

export type PlannedImage = {
  driveFileId: string;
  /** First 16 hex characters of the SHA-256 of the source bytes. */
  hash: string;
  width: number;
  height: number;
  widths: number[];
  rendition: ImageRendition;
  /** Every rendition's path, for checking a destination. */
  paths: string[];
  /** Encodes the renditions; memoized, so preview and site publishing share one encode. */
  encode: () => Promise<PublishAsset[]>;
};

export type ImagePlan = {
  images: Record<string, ImageRendition>;
  planned: PlannedImage[];
  warnings: string[];
};

export function imageIds(page: Page): string[] {
  const ids = new Set<string>();
  for (const section of page.sections) {
    for (const child of section.children) {
      const prose = child.kind === "prose" ? [child] : child.rows.flat().flatMap((cell) => cell.children);
      for (const node of prose) if (node.tag === "img" && node.image?.driveFileId) ids.add(node.image.driveFileId);
    }
  }
  return [...ids];
}

export function widthsFor(width: number): number[] {
  const widths = RENDITION_WIDTHS.filter((candidate) => candidate < width);
  const largest = Math.min(width, RENDITION_WIDTHS[RENDITION_WIDTHS.length - 1]);
  if (!widths.includes(largest)) widths.push(largest);
  return widths;
}

export function renditionFor(hash: string, width: number, height: number, widths: number[]): ImageRendition {
  const list = (ext: string) => widths.map((w) => ({ path: `assets/img/${hash}-${w}.${ext}`, width: w }));
  return { width, height, avif: list("avif"), webp: list("webp") };
}

function planOne(driveFileId: string, bytes: Uint8Array, width: number, height: number, hash: string): PlannedImage {
  const widths = widthsFor(width);
  const rendition = renditionFor(hash, width, height, widths);
  let encoded: Promise<PublishAsset[]> | null = null;
  return {
    driveFileId,
    hash,
    width,
    height,
    widths,
    rendition,
    paths: [...rendition.avif, ...rendition.webp].map((r) => r.path),
    encode: () =>
      (encoded ??= Promise.all(
        widths.flatMap((w) =>
          FORMATS.map(async (format) => {
            const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().resize({ width: w, withoutEnlargement: true });
            const body = await format.encode(image).toBuffer();
            return { path: `assets/img/${hash}-${w}.${format.ext}`, contentType: format.contentType, body: new Uint8Array(body) };
          }),
        ),
      )),
  };
}

/** Reads, hashes and measures each image on the page. Nothing is encoded yet. */
export async function planImages(page: Page, read = readMedia): Promise<ImagePlan> {
  const images: Record<string, ImageRendition> = {};
  const planned: PlannedImage[] = [];
  const warnings: string[] = [];
  for (const id of imageIds(page)) {
    const media = await read(id);
    if (!media) {
      warnings.push(`Image ${id} was not found`);
      continue;
    }
    try {
      const meta = await sharp(media.bytes, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
      if (!meta.width || !meta.height) throw new Error("no dimensions");
      // EXIF orientations 5 to 8 rotate the image a quarter turn.
      const turned = (meta.orientation ?? 1) >= 5;
      const width = turned ? meta.height : meta.width;
      const height = turned ? meta.width : meta.height;
      const hash = createHash("sha256").update(media.bytes).digest("hex").slice(0, 16);
      const image = planOne(id, media.bytes, width, height, hash);
      images[id] = image.rendition;
      planned.push(image);
    } catch {
      warnings.push(`Image ${id} could not be read as an image`);
    }
  }
  return { images, planned, warnings };
}

/** Rendition assets for the images a destination does not have yet. */
export async function encodeMissing(planned: PlannedImage[], has: (image: PlannedImage) => boolean | Promise<boolean>): Promise<{ assets: PublishAsset[]; encoded: PlannedImage[] }> {
  const encoded: PlannedImage[] = [];
  const assets: PublishAsset[] = [];
  for (const image of planned) {
    if (await has(image)) continue;
    assets.push(...(await image.encode()));
    encoded.push(image);
  }
  return { assets, encoded };
}

/** Images whose renditions a site already has (#61). Without Postgres, none. */
export async function siteHasRenditions(siteId: string, hashes: string[]): Promise<Set<string>> {
  if (!databaseConfigured() || hashes.length === 0) return new Set();
  const rows = await query<{ source_hash: string }>(
    "SELECT source_hash FROM image_renditions WHERE site_id = $1 AND source_hash = ANY($2::text[])",
    [siteId, hashes],
  );
  return new Set(rows.map((row) => row.source_hash));
}

/** Records renditions uploaded to a site, after the upload succeeded. */
export async function recordSiteRenditions(siteId: string, images: PlannedImage[]): Promise<void> {
  if (!databaseConfigured()) return;
  for (const image of images) {
    await query(
      `INSERT INTO image_renditions (site_id, source_hash, width, height, widths) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (site_id, source_hash) DO NOTHING`,
      [siteId, image.hash, image.width, image.height, image.widths],
    );
  }
}
