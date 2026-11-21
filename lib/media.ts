import { randomInt } from "node:crypto";

type MediaRecord = {
  mime: string;
  bytes: Uint8Array;
};

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const MAX_BYTES = 2_000_000;

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

export function saveMedia(bytes: Uint8Array, mime: string): { id: string } {
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("Image is too large");
  }
  let id = newMediaId();
  while (media.has(id)) id = newMediaId();
  media.set(id, { mime, bytes: copyBytes(bytes) });
  return { id };
}

export function readMedia(id: string): { mime: string; bytes: Uint8Array } | null {
  const found = media.get(id);
  if (!found) return null;
  return { mime: found.mime, bytes: copyBytes(found.bytes) };
}
