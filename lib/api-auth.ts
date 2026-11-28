import { accessTokenFor } from "@/lib/auth/server-sessions";
import { requestIdFrom } from "@/lib/audit";
import { looksLikeApiKey, verifyApiKey } from "@/lib/auth/api-keys";
import { looksLikeAccessToken, verifyAccessToken } from "@/lib/oauth/store";
import { databaseConfigured } from "@/lib/db/client";
import { encryptionConfigured } from "@/lib/crypto/secretbox";
import type { Scope, ServiceContext } from "@/lib/service";

/**
 * Bearer authentication for `/api/v1`, the MCP server and jobs (#36). Reads the
 * Authorization header only, never a cookie, so a cross-site request carries no
 * credential. Success returns an explicit service context whose scopes, site
 * folders and Google token come from the key and its owner's stored grant.
 */

export type Credential =
  | { kind: "api_key"; id: string; name: string; prefix: string }
  | { kind: "oauth"; id: string; name: string };

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
  const isKey = presented !== null && looksLikeApiKey(presented);
  const isOAuth = presented !== null && looksLikeAccessToken(presented);
  if (!presented || (!isKey && !isOAuth)) {
    return { ok: false, status: 401, code: "unauthenticated", error: "Send an API key or access token as Authorization: Bearer ..." };
  }
  if (!databaseConfigured() || !encryptionConfigured()) {
    return { ok: false, status: 503, code: "unavailable", error: "API credentials are not available on this instance." };
  }

  let sub: string;
  let scopes: readonly Scope[];
  let siteFolders: string[] | null = null;
  let credential: Credential;
  if (isKey) {
    const key = await verifyApiKey(presented);
    if (!key) return { ok: false, status: 401, code: "unauthenticated", error: "That API key is invalid, expired or revoked." };
    ({ sub, scopes, siteFolders } = key);
    credential = { kind: "api_key", id: key.id, name: key.name, prefix: key.prefix };
  } else {
    const access = await verifyAccessToken(presented);
    if (!access) return { ok: false, status: 401, code: "unauthenticated", error: "That access token is invalid, expired or revoked." };
    ({ sub, scopes } = access);
    credential = { kind: "oauth", id: access.clientId, name: access.clientName };
  }

  const googleToken = await accessTokenFor(sub);
  if (!googleToken) {
    return { ok: false, status: 401, code: "unauthenticated", error: "The owner needs to sign in to Pagefirst again to reconnect Google." };
  }
  return {
    ok: true,
    credential,
    ctx: {
      actor: { sub, client: isOAuth ? "mcp" : "api" },
      googleToken,
      requestId: requestIdFrom(request),
      scopes: new Set(scopes),
      ...(siteFolders ? { siteFolders } : {}),
    },
  };
}

export const unauthorizedHeaders = CHALLENGE;
