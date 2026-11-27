import { accessTokenFor } from "@/lib/auth/server-sessions";
import { requestIdFrom } from "@/lib/audit";
import { looksLikeApiKey, verifyApiKey } from "@/lib/auth/api-keys";
import { databaseConfigured } from "@/lib/db/client";
import { encryptionConfigured } from "@/lib/crypto/secretbox";
import type { ServiceContext } from "@/lib/service";

/**
 * Bearer authentication for `/api/v1`, the MCP server and jobs (#36). Reads the
 * Authorization header only, never a cookie, so a cross-site request carries no
 * credential. Success returns an explicit service context whose scopes, site
 * folders and Google token come from the key and its owner's stored grant.
 */

export type Credential = { kind: "api_key"; id: string; name: string; prefix: string };

export type ApiAuth =
  | { ok: true; ctx: ServiceContext; credential: Credential }
  | { ok: false; status: 401 | 503; error: string; code: "unauthenticated" | "unavailable" };

const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="pagefirst"' };

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
  return match ? match[1]! : null;
}

export async function authenticateBearer(request: Request): Promise<ApiAuth> {
  const presented = bearerToken(request);
  if (!presented || !looksLikeApiKey(presented)) {
    return { ok: false, status: 401, code: "unauthenticated", error: "Send an API key as Authorization: Bearer pf_live_..." };
  }
  if (!databaseConfigured() || !encryptionConfigured()) {
    return { ok: false, status: 503, code: "unavailable", error: "API keys are not available on this instance." };
  }
  const key = await verifyApiKey(presented);
  if (!key) return { ok: false, status: 401, code: "unauthenticated", error: "That API key is invalid, expired or revoked." };

  const googleToken = await accessTokenFor(key.sub);
  if (!googleToken) {
    return { ok: false, status: 401, code: "unauthenticated", error: "The key's owner needs to sign in to Pagefirst again to reconnect Google." };
  }
  return {
    ok: true,
    credential: { kind: "api_key", id: key.id, name: key.name, prefix: key.prefix },
    ctx: {
      actor: { sub: key.sub, client: "api" },
      googleToken,
      requestId: requestIdFrom(request),
      scopes: new Set(key.scopes),
      ...(key.siteFolders ? { siteFolders: key.siteFolders } : {}),
    },
  };
}

export const unauthorizedHeaders = CHALLENGE;
