import { createHash, timingSafeEqual } from "node:crypto";
import { SCOPES, type Scope } from "@/lib/service/context";

/** Pure OAuth 2.1 helpers: no database, no Next. */

export const ACCESS_TTL_SECONDS = 3600;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 600;

/** Exact-match redirect URIs: https, or http on a loopback host (native and desktop clients). */
export function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

export function parseRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) return null;
  const out: string[] = [];
  for (const uri of value) {
    if (!validRedirectUri(uri)) return null;
    if (!out.includes(uri)) out.push(uri);
  }
  return out;
}

/** The scopes asked for, or null when any is unknown. An empty request defaults to read-only. */
export function parseScopes(value: string | null | undefined): Scope[] | null {
  const parts = (value ?? "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return ["pages:read"];
  const out: Scope[] = [];
  for (const part of parts) {
    if (!(SCOPES as readonly string[]).includes(part)) return null;
    if (!out.includes(part as Scope)) out.push(part as Scope);
  }
  return out;
}

/** RFC 7636 S256 only. `plain` is not offered. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validChallenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function validVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  if (!validVerifier(verifier)) return false;
  const a = Buffer.from(challengeFor(verifier));
  const b = Buffer.from(challenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function protectedResourceMetadata(issuer: string) {
  return {
    resource: `${issuer}/api/v1`,
    authorization_servers: [issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
  };
}

/** Errors per RFC 6749 section 5.2. */
export type OAuthErrorCode = "invalid_request" | "invalid_client" | "invalid_grant" | "unsupported_grant_type" | "invalid_scope";
