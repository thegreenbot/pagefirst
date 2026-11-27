import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encryptionConfigured, open, seal } from "./secretbox";

describe("secretbox", () => {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  });

  test("round-trips and never contains the plaintext", () => {
    const sealed = seal("1//refresh-secret", "row:a");
    assert.ok(!sealed.includes("refresh-secret"));
    assert.equal(open(sealed, "row:a"), "1//refresh-secret");
    assert.notEqual(seal("x", "row:a"), seal("x", "row:a"), "a fresh IV each time");
  });

  test("refuses a ciphertext moved to another row", () => {
    assert.throws(() => open(seal("secret", "row:a"), "row:b"));
  });

  test("refuses a ciphertext sealed under another key", () => {
    const sealed = seal("secret", "row:a");
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.throws(() => open(sealed, "row:a"), /different key/);
  });

  test("refuses tampered or malformed input", () => {
    const parts = seal("secret", "row:a").split(".");
    parts[4] = Buffer.from("tampered").toString("base64url");
    assert.throws(() => open(parts.join("."), "row:a"));
    assert.throws(() => open("not-a-ciphertext", "row:a"), /Unrecognised/);
  });

  test("needs a 32-byte base64 key", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "short";
    assert.equal(encryptionConfigured(), false);
    assert.throws(() => seal("x", "y"), /32 bytes/);
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.equal(encryptionConfigured(), false);
  });
});
