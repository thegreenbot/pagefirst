import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { isSafePackagePath, PACKAGE_LIMITS, type ThemeFiles } from "./package";

/**
 * Theme package archives for the registry (#64): a gzipped POSIX ustar file
 * with regular files only. Packing is deterministic (sorted paths, zero
 * timestamps and owners, fixed modes), so the same theme directory always
 * gives the same bytes and the same integrity hash. Unpacking is strict:
 * checksums, sizes, file counts and path shapes are all checked, and nothing
 * touches the file system.
 */

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function header(name: string, size: number): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const put = (text: string, offset: number) => block.set(encoder.encode(text), offset);
  // Long names use the ustar prefix field; isSafePackagePath caps total length at 200.
  let prefix = "";
  let base = name;
  if (encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", 155);
    if (cut <= 0 || name.length - cut - 1 > 100) throw new Error(`${name}: path is too long for a theme archive`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  put(base, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(0, 12), 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\u000000", 257);
  put(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(octal(sum, 7) + " ", 148);
  return block;
}

/** Packs files into a deterministic .tgz. */
export function packTheme(files: ThemeFiles): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const name of [...files.keys()].sort()) {
    if (!isSafePackagePath(name)) throw new Error(`${name}: not a valid package path`);
    const body = files.get(name)!;
    parts.push(header(name, body.length), body);
    const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  return new Uint8Array(gzipSync(Buffer.concat(parts), { level: 9 }));
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("theme archive: bad number in header");
  return parseInt(text, 8);
}

/** Unpacks a .tgz made by packTheme (or any plain ustar with regular files), within PACKAGE_LIMITS. */
export function unpackTheme(archive: Uint8Array): ThemeFiles {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: PACKAGE_LIMITS.totalBytes + (PACKAGE_LIMITS.files + 2) * BLOCK * 2 });
  } catch {
    throw new Error("theme archive: not a valid gzip file or too large");
  }
  const files: ThemeFiles = new Map();
  let total = 0;
  let at = 0;
  while (at + BLOCK <= tar.length) {
    const block = tar.subarray(at, at + BLOCK);
    if (block.every((byte) => byte === 0)) return files;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i]!;
    if (readOctal(block, 148, 8) !== sum) throw new Error("theme archive: header checksum mismatch");
    const type = String.fromCharCode(block[156]!);
    if (type !== "0" && type !== "\0") throw new Error("theme archive: only regular files are allowed");
    const prefix = readString(block, 345, 155);
    const name = prefix ? `${prefix}/${readString(block, 0, 100)}` : readString(block, 0, 100);
    if (!isSafePackagePath(name)) throw new Error(`theme archive: ${JSON.stringify(name)} is not a valid package path`);
    if (files.has(name)) throw new Error(`theme archive: ${name} appears twice`);
    const size = readOctal(block, 124, 12);
    total += size;
    if (files.size + 1 > PACKAGE_LIMITS.files || total > PACKAGE_LIMITS.totalBytes) throw new Error("theme archive: larger than a theme package may be");
    const start = at + BLOCK;
    if (start + size > tar.length) throw new Error("theme archive: truncated");
    files.set(name, new Uint8Array(tar.subarray(start, start + size)));
    at = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  throw new Error("theme archive: missing end-of-archive marker");
}

/** npm-style integrity of an archive's exact bytes. */
export function archiveIntegrity(archive: Uint8Array): string {
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}
