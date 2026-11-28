import { randomBytes } from "node:crypto";
import { lookupDigest } from "@/lib/crypto/hash";
import { query } from "@/lib/db/client";
import { SCOPES, type Scope } from "@/lib/service/context";

/**
 * Scoped API keys (#36, ADR 0003). A key acts as the user who created it, with
 * the scopes, site folders and expiry chosen at creation. The key is shown once;
 * only a keyed hash (HMAC-SHA256) is stored. Every request looks the key up in the database, so
 * a revoke takes effect on the next request.
 */

export const KEY_PREFIX = "pf_live_";
export const MAX_ACTIVE_KEYS = 25;
export const DEFAULT_EXPIRY_DAYS = 90;
export const MAX_EXPIRY_DAYS = 365;
const LAST_USED_GRANULARITY = "1 minute";

export type ApiKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  siteFolders: string[] | null;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export type VerifiedKey = ApiKeyRecord & { sub: string };

export class KeyInputError extends Error {}

type Row = {
  id: string;
  sub: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  site_folders: string[] | null;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

const COLUMNS = "id, sub, name, key_prefix, scopes, site_folders, expires_at, created_at, last_used_at, revoked_at";

function record(row: Row): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    prefix: row.key_prefix,
    scopes: row.scopes.filter((scope): scope is Scope => (SCOPES as readonly string[]).includes(scope)),
    siteFolders: row.site_folders,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

export function hashApiKey(presented: string): string {
  return lookupDigest(presented);
}

/** True when the string looks like one of our keys, so other bearer tokens are not looked up. */
export function looksLikeApiKey(value: string): boolean {
  return /^pf_live_[A-Za-z0-9_-]{43}$/.test(value);
}

export type NewKeyInput = { name?: unknown; scopes?: unknown; siteFolders?: unknown; expiresInDays?: unknown };

/** Validates a create request. Throws KeyInputError with a message safe to show. */
export function parseNewKey(input: unknown): { name: string; scopes: Scope[]; siteFolders: string[] | null; expiresInDays: number } {
  if (typeof input !== "object" || input === null) throw new KeyInputError("Send a JSON object.");
  const body = input as NewKeyInput;

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) throw new KeyInputError("name must be 1 to 80 characters.");

  if (!Array.isArray(body.scopes) || body.scopes.length === 0) throw new KeyInputError("scopes must list at least one scope.");
  const scopes: Scope[] = [];
  for (const value of body.scopes) {
    if (typeof value !== "string" || !(SCOPES as readonly string[]).includes(value)) {
      throw new KeyInputError(`Unknown scope. Use ${SCOPES.join(", ")}.`);
    }
    if (!scopes.includes(value as Scope)) scopes.push(value as Scope);
  }

  let siteFolders: string[] | null = null;
  if (body.siteFolders !== undefined && body.siteFolders !== null) {
    if (!Array.isArray(body.siteFolders) || body.siteFolders.length === 0 || body.siteFolders.length > 50) {
      throw new KeyInputError("siteFolders must list 1 to 50 Drive folder ids, or be left out.");
    }
    siteFolders = [];
    for (const value of body.siteFolders) {
      if (typeof value !== "string" || !/^[\w-]{10,128}$/.test(value)) throw new KeyInputError("siteFolders holds an invalid Drive folder id.");
      if (!siteFolders.includes(value)) siteFolders.push(value);
    }
  }

  const days = body.expiresInDays === undefined ? DEFAULT_EXPIRY_DAYS : body.expiresInDays;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) {
    throw new KeyInputError(`expiresInDays must be a whole number from 1 to ${MAX_EXPIRY_DAYS}.`);
  }
  return { name, scopes, siteFolders, expiresInDays: days };
}

/** Creates a key. The returned `key` is the only time it can be read. */
export async function issueBearer(sub: string, input: unknown): Promise<{ key: string; record: ApiKeyRecord }> {
  const { name, scopes, siteFolders, expiresInDays } = parseNewKey(input);
  const active = await query<{ n: string }>(
    "SELECT count(*) AS n FROM api_keys WHERE sub = $1 AND revoked_at IS NULL AND expires_at > now()",
    [sub],
  );
  if (Number(active[0]?.n ?? 0) >= MAX_ACTIVE_KEYS) {
    throw new KeyInputError(`You have ${MAX_ACTIVE_KEYS} active keys. Revoke one first.`);
  }
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const rows = await query<Row>(
    `INSERT INTO api_keys (sub, name, key_prefix, key_hash, scopes, site_folders, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7))
     RETURNING ${COLUMNS}`,
    [sub, name, key.slice(0, KEY_PREFIX.length + 4), hashApiKey(key), scopes, siteFolders, expiresInDays],
  );
  return { key, record: record(rows[0]!) };
}

export async function listApiKeys(sub: string): Promise<ApiKeyRecord[]> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM api_keys WHERE sub = $1 ORDER BY created_at DESC LIMIT 200`, [sub]);
  return rows.map(record);
}

/** Revokes one of the user's keys. False when it is not theirs or already revoked. */
export async function revokeApiKey(sub: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return false;
  const rows = await query<{ id: string }>(
    "UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND sub = $2 AND revoked_at IS NULL RETURNING id",
    [id, sub],
  );
  return rows.length === 1;
}

/** The key behind a presented secret, or null when it is unknown, revoked or expired. */
export async function verifyApiKey(presented: string): Promise<VerifiedKey | null> {
  if (!looksLikeApiKey(presented)) return null;
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hashApiKey(presented)],
  );
  const row = rows[0];
  if (!row) return null;
  // Throttled so a busy script does not write on every call.
  void query(
    `UPDATE api_keys SET last_used_at = now()
     WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '${LAST_USED_GRANULARITY}')`,
    [row.id],
  ).catch(() => undefined);
  return { ...record(row), sub: row.sub };
}
