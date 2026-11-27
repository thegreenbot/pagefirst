import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync, gzipSync } from "node:zlib";
import { generateKeyPairSync } from "node:crypto";
import { loadThemeFromFiles, readThemeDir, type ThemeFiles } from "./package";
import { countersign, verifyCountersignature } from "./signing";
import { archiveIntegrity, packTheme, unpackTheme } from "./tarball";

const text = (value: string) => new TextEncoder().encode(value);

/** Rewrites one header field of the first entry and fixes the checksum, to build hostile archives. */
function withFirstHeader(archive: Uint8Array, edit: (block: Buffer) => void, fixChecksum = true): Uint8Array {
  const tar = Buffer.from(gunzipSync(archive));
  const block = tar.subarray(0, 512);
  edit(block);
  if (fixChecksum) {
    block.fill(32, 148, 156);
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  }
  return new Uint8Array(gzipSync(tar));
}

describe("theme archives (#64)", () => {
  test("packing is deterministic and round-trips every file byte for byte", () => {
    const files = readThemeDir("themes/default");
    const a = packTheme(files);
    const b = packTheme(readThemeDir("themes/default"));
    assert.equal(archiveIntegrity(a), archiveIntegrity(b));
    assert.match(archiveIntegrity(a), /^sha512-[A-Za-z0-9+/]{86}==$/);
    const back = unpackTheme(a);
    assert.deepEqual([...back.keys()].sort(), [...files.keys()].sort());
    for (const [name, bytes] of files) assert.ok(Buffer.from(bytes).equals(Buffer.from(back.get(name)!)), name);
    assert.equal(loadThemeFromFiles(back).manifest.name, "@pagefirst/default");
  });

  test("long paths use the ustar prefix field", () => {
    const name = `${"a".repeat(60)}/${"b".repeat(60)}/c.txt`;
    const back = unpackTheme(packTheme(new Map([[name, text("x")]])));
    assert.equal(new TextDecoder().decode(back.get(name)), "x");
  });

  const one: ThemeFiles = new Map([["theme.json", text("{}")]]);

  const hostile: [string, () => Uint8Array, RegExp][] = [
    ["a parent-directory path", () => withFirstHeader(packTheme(one), (h) => h.write("../evil\0\0\0\0", 0, "latin1")), /not a valid package path/],
    ["an absolute path", () => withFirstHeader(packTheme(one), (h) => h.write("/etc/passwd\0", 0, "latin1")), /not a valid package path/],
    ["a symlink", () => withFirstHeader(packTheme(one), (h) => h.write("2", 156, "latin1")), /only regular files/],
    ["a directory entry", () => withFirstHeader(packTheme(one), (h) => h.write("5", 156, "latin1")), /only regular files/],
    ["a bad header checksum", () => withFirstHeader(packTheme(one), (h) => h.write("x", 0, "latin1"), false), /checksum/],
    ["a size past the end", () => withFirstHeader(packTheme(one), (h) => h.write("00000777777\0", 124, "latin1")), /truncated|larger/],
    ["non-gzip bytes", () => text("not an archive"), /not a valid gzip/],
    ["a missing end marker", () => new Uint8Array(gzipSync(Buffer.from(gunzipSync(packTheme(one))).subarray(0, 1024))), /end-of-archive/],
  ];
  for (const [what, make, error] of hostile) {
    test(`rejects ${what}`, () => assert.throws(() => unpackTheme(make()), error));
  }

  test("rejects an archive with too many files", () => {
    const many: ThemeFiles = new Map(Array.from({ length: 513 }, (_, i) => [`f${i}.txt`, text("x")]));
    assert.throws(() => unpackTheme(packTheme(many)), /larger than a theme package/);
  });

  test("refuses to pack an unsafe path", () => {
    assert.throws(() => packTheme(new Map([["../x", text("x")]])), /not a valid package path/);
  });
});

describe("registry countersignatures (#64)", () => {
  const keys = () => generateKeyPairSync("ed25519");
  const pem = (k: ReturnType<typeof keys>) => ({
    priv: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    pubDer: k.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  });

  test("signs name, version and integrity, and verifies with any configured key", () => {
    const [current, old] = [pem(keys()), pem(keys())];
    process.env.THEME_REGISTRY_SIGNING_KEY = current.priv;
    process.env.THEME_REGISTRY_PUBLIC_KEYS = `${old.pubDer}, ${current.pubDer}`;
    const signature = countersign("@pagefirst/default", "1.0.0", "sha512-abc");
    assert.equal(verifyCountersignature("@pagefirst/default", "1.0.0", "sha512-abc", signature), true);
    assert.equal(verifyCountersignature("@pagefirst/default", "1.0.1", "sha512-abc", signature), false);
    assert.equal(verifyCountersignature("@pagefirst/default", "1.0.0", "sha512-abd", signature), false);
    assert.equal(verifyCountersignature("@pagefirst/default", "1.0.0", "sha512-abc", "bm90IGEgc2ln"), false);
    process.env.THEME_REGISTRY_PUBLIC_KEYS = old.pubDer;
    assert.equal(verifyCountersignature("@pagefirst/default", "1.0.0", "sha512-abc", signature), false);
    delete process.env.THEME_REGISTRY_SIGNING_KEY;
    delete process.env.THEME_REGISTRY_PUBLIC_KEYS;
  });

  test("without keys nothing is signed and nothing verifies", () => {
    assert.throws(() => countersign("@a/b", "1.0.0", "sha512-x"), /THEME_REGISTRY_SIGNING_KEY/);
    assert.equal(verifyCountersignature("@a/b", "1.0.0", "sha512-x", "AAAA"), false);
  });

  test("refuses a key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.THEME_REGISTRY_SIGNING_KEY = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    assert.throws(() => countersign("@a/b", "1.0.0", "sha512-x"), /Ed25519/);
    delete process.env.THEME_REGISTRY_SIGNING_KEY;
  });
});
