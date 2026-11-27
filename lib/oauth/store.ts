import { randomBytes, randomUUID } from "node:crypto";
import { lookupDigest } from "@/lib/crypto/hash";
import { query, transaction } from "@/lib/db/client";
import { SCOPES, type Scope } from "@/lib/service/context";
import { ACCESS_TTL_SECONDS, CODE_TTL_SECONDS, REFRESH_TTL_SECONDS, verifyPkce } from "./protocol";

export const CLIENT_LIMIT_PER_HOUR = 30;

const sha = lookupDigest;
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;
const asScopes = (values: string[]): Scope[] => values.filter((v): v is Scope => (SCOPES as readonly string[]).includes(v));

export const ACCESS_PREFIX = "pf_at_";
export const REFRESH_PREFIX = "pf_rt_";
const CODE_PREFIX = "pf_ac_";

export function looksLikeAccessToken(value: string): boolean {
  return /^pf_at_[A-Za-z0-9_-]{43}$/.test(value);
}

export type OAuthClient = { clientId: string; name: string; redirectUris: string[] };

export async function registerClient(name: string, redirectUris: string[]): Promise<OAuthClient> {
  const clientId = `pf_client_${randomBytes(16).toString("base64url")}`;
  await query("INSERT INTO oauth_clients (client_id, name, redirect_uris) VALUES ($1, $2, $3)", [clientId, name, redirectUris]);
  return { clientId, name, redirectUris };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  if (!/^pf_client_[A-Za-z0-9_-]{22}$/.test(clientId)) return null;
  const rows = await query<{ client_id: string; name: string; redirect_uris: string[] }>(
    "SELECT client_id, name, redirect_uris FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  const row = rows[0];
  return row ? { clientId: row.client_id, name: row.name, redirectUris: row.redirect_uris } : null;
}

/** A single-use authorization code for a user who approved the consent screen. */
export async function issueCode(input: { clientId: string; sub: string; scopes: Scope[]; codeChallenge: string; redirectUri: string }): Promise<string> {
  const code = secret(CODE_PREFIX);
  await query(
    `INSERT INTO oauth_codes (code_hash, client_id, sub, scopes, code_challenge, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
    [sha(code), input.clientId, input.sub, input.scopes, input.codeChallenge, input.redirectUri, CODE_TTL_SECONDS],
  );
  return code;
}

export type TokenSet = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };
export type ExchangeResult = { ok: true; tokens: TokenSet } | { ok: false; error: "invalid_grant" };

type Tx = import("pg").PoolClient;

async function mintTokens(tx: Tx, familyId: string, clientId: string, sub: string, scopes: Scope[]): Promise<TokenSet> {
  const access = secret(ACCESS_PREFIX);
  const refresh = secret(REFRESH_PREFIX);
  await tx.query(
    `INSERT INTO oauth_tokens (token_hash, kind, family_id, client_id, sub, scopes, expires_at) VALUES
     ($1, 'access',  $3, $4, $5, $6, now() + make_interval(secs => $7)),
     ($2, 'refresh', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [sha(access), sha(refresh), familyId, clientId, sub, scopes, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS],
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopes.join(" ") };
}

/** Trades a code plus its PKCE verifier for tokens. A code works once; replaying it revokes what it issued. */
export async function exchangeCode(input: { clientId: string; code: string; codeVerifier: string; redirectUri: string }): Promise<ExchangeResult> {
  return transaction(async (tx) => {
    const { rows } = await tx.query<{
      client_id: string; sub: string; scopes: string[]; code_challenge: string; redirect_uri: string; expires_at: Date; used_at: Date | null;
    }>("SELECT client_id, sub, scopes, code_challenge, redirect_uri, expires_at, used_at FROM oauth_codes WHERE code_hash = $1 FOR UPDATE", [sha(input.code)]);
    const row = rows[0];
    if (!row || row.client_id !== input.clientId) return { ok: false, error: "invalid_grant" } as const;
    if (row.used_at) {
      // Replay: revoke everything this code produced.
      await tx.query("UPDATE oauth_tokens SET revoked_at = now() WHERE client_id = $1 AND sub = $2 AND revoked_at IS NULL AND created_at >= $3", [row.client_id, row.sub, row.used_at]);
      return { ok: false, error: "invalid_grant" } as const;
    }
    if (row.expires_at.getTime() < Date.now() || row.redirect_uri !== input.redirectUri || !verifyPkce(input.codeVerifier, row.code_challenge)) {
      return { ok: false, error: "invalid_grant" } as const;
    }
    await tx.query("UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1", [sha(input.code)]);
    const tokens = await mintTokens(tx, randomUUID(), row.client_id, row.sub, asScopes(row.scopes));
    return { ok: true, tokens } as const;
  });
}

/** Rotates a refresh token. Presenting one that was already used revokes the whole family. */
export async function refresh(input: { clientId: string; refreshToken: string }): Promise<ExchangeResult> {
  return transaction(async (tx) => {
    const { rows } = await tx.query<{
      family_id: string; client_id: string; sub: string; scopes: string[]; expires_at: Date; used_at: Date | null; revoked_at: Date | null;
    }>("SELECT family_id, client_id, sub, scopes, expires_at, used_at, revoked_at FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' FOR UPDATE", [sha(input.refreshToken)]);
    const row = rows[0];
    if (!row || row.client_id !== input.clientId) return { ok: false, error: "invalid_grant" } as const;
    if (row.used_at || row.revoked_at) {
      await tx.query("UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
      return { ok: false, error: "invalid_grant" } as const;
    }
    if (row.expires_at.getTime() < Date.now()) return { ok: false, error: "invalid_grant" } as const;
    await tx.query("UPDATE oauth_tokens SET used_at = now(), revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
    // used_at marks the spent refresh token; revoking the family also retires its old access token.
    const tokens = await mintTokens(tx, row.family_id, row.client_id, row.sub, asScopes(row.scopes));
    return { ok: true, tokens } as const;
  });
}

export type VerifiedAccess = { sub: string; scopes: Scope[]; clientId: string; clientName: string };

/** The user, scopes and client behind an access token, or null when unknown, expired or revoked. */
export async function verifyAccessToken(token: string): Promise<VerifiedAccess | null> {
  if (!looksLikeAccessToken(token)) return null;
  const rows = await query<{ sub: string; scopes: string[]; client_id: string; name: string }>(
    `SELECT t.sub, t.scopes, t.client_id, c.name FROM oauth_tokens t JOIN oauth_clients c USING (client_id)
     WHERE t.token_hash = $1 AND t.kind = 'access' AND t.revoked_at IS NULL AND t.expires_at > now()`,
    [sha(token)],
  );
  const row = rows[0];
  return row ? { sub: row.sub, scopes: asScopes(row.scopes), clientId: row.client_id, clientName: row.name } : null;
}

/** RFC 7009: revoking a refresh token ends its whole family; an access token ends itself. Always succeeds. */
export async function revokeToken(clientId: string, token: string): Promise<void> {
  const rows = await query<{ family_id: string; kind: string }>("SELECT family_id, kind FROM oauth_tokens WHERE token_hash = $1 AND client_id = $2", [sha(token), clientId]);
  const row = rows[0];
  if (!row) return;
  if (row.kind === "refresh") await query("UPDATE oauth_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL", [row.family_id]);
  else await query("UPDATE oauth_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL", [sha(token)]);
}

/** "Sign out everywhere" for MCP clients: revokes every token a user has issued. */
export async function revokeAllForUser(sub: string): Promise<void> {
  await query("UPDATE oauth_tokens SET revoked_at = now() WHERE sub = $1 AND revoked_at IS NULL", [sub]);
}
