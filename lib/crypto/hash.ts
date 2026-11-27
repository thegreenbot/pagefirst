import { createHmac, hkdfSync } from "node:crypto";

/**
 * Lookup hash for high-entropy bearer secrets (API keys, OAuth tokens). These
 * are 256 random bits, not passwords, so a slow hash adds nothing. HMAC-SHA256
 * under a key derived from TOKEN_ENCRYPTION_KEY means a database dump alone
 * cannot even be used to test guesses. Rotating TOKEN_ENCRYPTION_KEY invalidates
 * every key and token, so rotation also revokes them (see runbooks/secret-rotation.md).
 */
function pepper(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new Error("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64");
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "pagefirst bearer secret hash v1", 32));
}

export function lookupDigest(value: string): string {
  return createHmac("sha256", pepper()).update(value).digest("hex");
}
