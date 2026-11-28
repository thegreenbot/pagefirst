import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

/**
 * Registry countersignatures (#64). After a version passes the registry's
 * checks, the registry signs its name, version and archive integrity with an
 * Ed25519 key. Every publish verifies that signature with the registry's
 * public keys before rendering with the version, so a tampered archive or a
 * row written without the private key never renders.
 *
 * THEME_REGISTRY_SIGNING_KEY: the private key (PKCS#8 PEM, or its base64 DER).
 * THEME_REGISTRY_PUBLIC_KEYS: comma-separated public keys (SPKI PEM or base64
 * DER). More than one allows key rotation.
 */

export function countersignPayload(name: string, version: string, integrity: string): Buffer {
  return Buffer.from(`pagefirst-theme-registry/v1\n${name}\n${version}\n${integrity}\n`, "utf8");
}

function keyMaterial(value: string): { key: string | Buffer; format: "pem" | "der" } {
  const trimmed = value.trim();
  return trimmed.startsWith("-----BEGIN") ? { key: trimmed.replace(/\\n/g, "\n"), format: "pem" } : { key: Buffer.from(trimmed, "base64"), format: "der" };
}

function privateKey(): KeyObject | null {
  const value = process.env.THEME_REGISTRY_SIGNING_KEY;
  if (!value) return null;
  const { key, format } = keyMaterial(value);
  const object = format === "pem" ? createPrivateKey(key) : createPrivateKey({ key: key as Buffer, format: "der", type: "pkcs8" });
  if (object.asymmetricKeyType !== "ed25519") throw new Error("THEME_REGISTRY_SIGNING_KEY must be an Ed25519 key");
  return object;
}

export function registryPublicKeys(): KeyObject[] {
  return (process.env.THEME_REGISTRY_PUBLIC_KEYS ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((value) => {
      const { key, format } = keyMaterial(value);
      const object = format === "pem" ? createPublicKey(key) : createPublicKey({ key: key as Buffer, format: "der", type: "spki" });
      if (object.asymmetricKeyType !== "ed25519") throw new Error("THEME_REGISTRY_PUBLIC_KEYS must hold Ed25519 keys");
      return object;
    });
}

/** Signs a version; throws when the registry has no signing key, so nothing is published unsigned. */
export function countersign(name: string, version: string, integrity: string): string {
  const key = privateKey();
  if (!key) throw new Error("THEME_REGISTRY_SIGNING_KEY is not set; the registry cannot countersign");
  return sign(null, countersignPayload(name, version, integrity), key).toString("base64");
}

/** True when any configured registry key signed exactly this name, version and integrity. */
export function verifyCountersignature(name: string, version: string, integrity: string, signature: string): boolean {
  const payload = countersignPayload(name, version, integrity);
  const bytes = Buffer.from(signature, "base64");
  return registryPublicKeys().some((key) => {
    try {
      return verify(null, payload, key, bytes);
    } catch {
      return false;
    }
  });
}
