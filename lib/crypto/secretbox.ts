import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets stored in the database (Google refresh tokens).
 * The key is TOKEN_ENCRYPTION_KEY: 32 random bytes, base64. Ciphertext format:
 * `v1.<keyId>.<iv>.<tag>.<data>` (base64url parts), where keyId is a short hash
 * of the key so a rotated key can be told apart from the current one.
 */

const VERSION = "v1";

function keyBytes(raw = process.env.TOKEN_ENCRYPTION_KEY): Buffer {
  const value = raw?.trim();
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64");
  return key;
}

export function encryptionConfigured(): boolean {
  try {
    keyBytes();
    return true;
  } catch {
    return false;
  }
}

export function keyId(key: Buffer = keyBytes()): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
}

export function seal(plaintext: string, associatedData: string): string {
  const key = keyBytes();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyId(key), iv.toString("base64url"), tag.toString("base64url"), data.toString("base64url")].join(".");
}

/** Decrypts a value from `seal`. `associatedData` must match, so a ciphertext can't be moved to another row. */
export function open(sealed: string, associatedData: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new Error("Unrecognised ciphertext");
  const key = keyBytes();
  if (parts[1] !== keyId(key)) throw new Error("Ciphertext was sealed with a different key");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[2], "base64url"));
  decipher.setAAD(Buffer.from(associatedData));
  decipher.setAuthTag(Buffer.from(parts[3], "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(parts[4], "base64url")), decipher.final()]).toString("utf8");
}
