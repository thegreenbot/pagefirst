import { randomBytes } from "node:crypto";
import { lookupDigest } from "@/lib/crypto/hash";
import { query } from "@/lib/db/client";

/**
 * SCIM bearer tokens (#49). One per identity-provider connection, scoped to a
 * single organization. Shown once; only a keyed hash is stored, and a revoke
 * takes effect on the next request.
 */

export const SCIM_PREFIX = "pf_scim_";
export const MAX_ACTIVE_TOKENS = 5;

export type ScimToken = { id: string; label: string; prefix: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null };

type Row = { id: string; label: string; token_prefix: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null };
const toToken = (r: Row): ScimToken => ({
  id: r.id,
  label: r.label,
  prefix: r.token_prefix,
  createdAt: r.created_at.toISOString(),
  lastUsedAt: r.last_used_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

export const looksLikeScimToken = (value: string): boolean => /^pf_scim_[A-Za-z0-9_-]{43}$/.test(value);

export class ScimTokenError extends Error {}

export async function createScimToken(orgId: string, createdBy: string, label: string): Promise<{ token: string; record: ScimToken }> {
  const name = label.trim().slice(0, 80);
  if (!name) throw new ScimTokenError("Give the token a label, such as the identity provider's name.");
  const active = await query<{ n: string }>("SELECT count(*) AS n FROM scim_tokens WHERE org_id = $1 AND revoked_at IS NULL", [orgId]);
  if (Number(active[0]?.n ?? 0) >= MAX_ACTIVE_TOKENS) throw new ScimTokenError(`An organization can have ${MAX_ACTIVE_TOKENS} active SCIM tokens. Revoke one first.`);
  const token = `${SCIM_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = `scim_${randomBytes(9).toString("base64url")}`;
  const rows = await query<Row>(
    `INSERT INTO scim_tokens (id, org_id, label, token_prefix, token_hash, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, label, token_prefix, created_at, last_used_at, revoked_at`,
    [id, orgId, name, token.slice(0, SCIM_PREFIX.length + 6), lookupDigest(token), createdBy],
  );
  return { token, record: toToken(rows[0]!) };
}

export async function listScimTokens(orgId: string): Promise<ScimToken[]> {
  const rows = await query<Row>(
    "SELECT id, label, token_prefix, created_at, last_used_at, revoked_at FROM scim_tokens WHERE org_id = $1 ORDER BY created_at DESC",
    [orgId],
  );
  return rows.map(toToken);
}

export async function revokeScimToken(orgId: string, id: string): Promise<boolean> {
  const rows = await query("UPDATE scim_tokens SET revoked_at = now() WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL RETURNING id", [id, orgId]);
  return rows.length > 0;
}

/** The organization and token a presented bearer belongs to, or null if unknown or revoked. */
export async function verifyScimToken(presented: string): Promise<{ tokenId: string; orgId: string } | null> {
  if (!looksLikeScimToken(presented)) return null;
  const rows = await query<{ id: string; org_id: string }>(
    `UPDATE scim_tokens SET last_used_at = CASE WHEN last_used_at IS NULL OR last_used_at < now() - interval '1 minute' THEN now() ELSE last_used_at END
      WHERE token_hash = $1 AND revoked_at IS NULL RETURNING id, org_id`,
    [lookupDigest(presented)],
  );
  return rows[0] ? { tokenId: rows[0].id, orgId: rows[0].org_id } : null;
}
