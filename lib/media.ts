import { randomInt } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";

type MediaRecord = {
  mime: string;
  bytes: Uint8Array;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_BYTES = 2_000_000;
const MAX_UPLOADS = 24;
const SEED_ID = "sample-studio";

const STUDIO_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">',
  '<rect width="640" height="360" fill="#e4efe9"/>',
  '<text x="320" y="180" text-anchor="middle" dominant-baseline="central" fill="#1a4738" font-family="sans-serif" font-size="64">Studio</text>',
  "</svg>",
].join("");

const mediaHolder = globalThis as typeof globalThis & {
  __pageFirstMedia?: Map<string, MediaRecord>;
};

const media: Map<string, MediaRecord> =
  mediaHolder.__pageFirstMedia ??
  new Map<string, MediaRecord>([
    [
      "sample-studio",
      {
        mime: "image/svg+xml",
        bytes: new TextEncoder().encode(STUDIO_SVG),
      },
    ],
  ]);

mediaHolder.__pageFirstMedia = media;

function newMediaId(): string {
  let suffix = "";
  for (let index = 0; index < 8; index += 1) {
    suffix += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  }
  return `m_${suffix}`;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("Image is too large");
  }
}

/**
 * Stores an uploaded image (#18). With Postgres, every instance can serve it
 * and the cap of MAX_UPLOADS is per account; without it, images live in this
 * process's memory with one shared cap.
 */
export async function saveMedia(bytes: Uint8Array, mime: string, ownerKey = "local"): Promise<{ id: string }> {
  checkSize(bytes);
  if (databaseConfigured()) {
    const [row] = await query<{ uploads: number }>("SELECT count(*)::int AS uploads FROM media WHERE owner_key = $1", [ownerKey]);
    if ((row?.uploads ?? 0) >= MAX_UPLOADS) throw new Error("Image library is full");
    const id = newMediaId();
    await query("INSERT INTO media (id, owner_key, mime, bytes) VALUES ($1, $2, $3, $4)", [id, ownerKey, mime, Buffer.from(bytes)]);
    return { id };
  }
  let uploads = 0;
  for (const id of media.keys()) {
    if (id !== SEED_ID) uploads += 1;
  }
  if (uploads >= MAX_UPLOADS) {
    throw new Error("Image library is full");
  }
  let id = newMediaId();
  while (media.has(id)) id = newMediaId();
  media.set(id, { mime, bytes: copyBytes(bytes) });
  return { id };
}

export async function readMedia(id: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (databaseConfigured() && id !== SEED_ID) {
    const [row] = await query<{ mime: string; bytes: Buffer }>("SELECT mime, bytes FROM media WHERE id = $1", [id]);
    return row ? { mime: row.mime, bytes: new Uint8Array(row.bytes) } : null;
  }
  const found = media.get(id);
  if (!found) return null;
  return { mime: found.mime, bytes: copyBytes(found.bytes) };
}
