import { createHash, randomBytes } from "node:crypto";
import { query, transaction, upsertUser } from "@/lib/db/client";
import { open, seal } from "@/lib/crypto/secretbox";
import { refreshAccessToken, revokeToken, type GoogleGrant } from "@/lib/google/oauth";

/**
 * Server-side sessions (#16). The browser holds only a random session id; the
 * database holds its hash, and Google tokens sealed with TOKEN_ENCRYPTION_KEY.
 */

export const IDLE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
/** Refresh this long before Google's expiry, so a token never dies mid-request. */
const EXPIRY_MARGIN_MS = 60_000;
/** Write last_seen_at at most this often per session. */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type Session = { sub: string; createdAt: Date; lastSeenAt: Date };
export type SessionSummary = { id: string; userAgent: string | null; createdAt: string; lastSeenAt: string; current: boolean };

export function hashSessionId(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

const sealContext = (sub: string, kind: "refresh" | "access") => `google_tokens:${sub}:${kind}`;

/** Stores (or replaces) a user's Google grant. A sign-in without a refresh token keeps the old one. */
export async function saveGrant(sub: string, email: string | null, grant: GoogleGrant): Promise<void> {
  await upsertUser(sub, email);
  const access = seal(grant.accessToken, sealContext(sub, "access"));
  const expiresAt = new Date(Date.now() + grant.expiresInSeconds * 1000);
  if (grant.refreshToken) {
    await query(
      `INSERT INTO google_tokens (sub, refresh_token_sealed, access_token_sealed, access_expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sub) DO UPDATE SET
         refresh_token_sealed = EXCLUDED.refresh_token_sealed,
         access_token_sealed = EXCLUDED.access_token_sealed,
         access_expires_at = EXCLUDED.access_expires_at,
         scopes = EXCLUDED.scopes,
         last_used_at = now()`,
      [sub, seal(grant.refreshToken, sealContext(sub, "refresh")), access, expiresAt, grant.scope],
    );
  } else {
    const updated = await query(
      `UPDATE google_tokens SET access_token_sealed = $2, access_expires_at = $3, last_used_at = now()
       WHERE sub = $1 RETURNING sub`,
      [sub, access, expiresAt],
    );
    if (updated.length === 0) throw new Error("Google did not return a refresh token");
  }
}

export async function createSession(sub: string, userAgent: string | null): Promise<string> {
  const id = randomBytes(32).toString("base64url");
  await query("INSERT INTO sessions (id_hash, sub, user_agent) VALUES ($1, $2, $3)", [
    hashSessionId(id),
    sub,
    userAgent?.slice(0, 200) ?? null,
  ]);
  return id;
}

/** The session for this id, or null when unknown or past its idle or absolute timeout (it is then deleted). */
export async function readSession(id: string): Promise<Session | null> {
  const rows = await query<{ sub: string; created_at: Date; last_seen_at: Date }>(
    "SELECT sub, created_at, last_seen_at FROM sessions WHERE id_hash = $1",
    [hashSessionId(id)],
  );
  const row = rows[0];
  if (!row) return null;
  const now = Date.now();
  if (now - row.created_at.getTime() > ABSOLUTE_TIMEOUT_MS || now - row.last_seen_at.getTime() > IDLE_TIMEOUT_MS) {
    await deleteSession(id);
    return null;
  }
  if (now - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await query("UPDATE sessions SET last_seen_at = now() WHERE id_hash = $1", [hashSessionId(id)]);
  }
  return { sub: row.sub, createdAt: row.created_at, lastSeenAt: row.last_seen_at };
}

export async function deleteSession(id: string): Promise<void> {
  await query("DELETE FROM sessions WHERE id_hash = $1", [hashSessionId(id)]);
}

export async function listSessions(sub: string, currentId: string | null): Promise<SessionSummary[]> {
  const currentHash = currentId ? hashSessionId(currentId) : null;
  const rows = await query<{ id_hash: string; user_agent: string | null; created_at: Date; last_seen_at: Date }>(
    "SELECT id_hash, user_agent, created_at, last_seen_at FROM sessions WHERE sub = $1 ORDER BY last_seen_at DESC",
    [sub],
  );
  return rows.map((row) => ({
    // A prefix of the hash identifies the session without revealing anything usable.
    id: row.id_hash.slice(0, 12),
    userAgent: row.user_agent,
    createdAt: row.created_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    current: row.id_hash === currentHash,
  }));
}

/** Revokes the grant at Google, then deletes the stored tokens and every session for the user. */
export async function disconnectGoogle(sub: string): Promise<void> {
  const rows = await query<{ refresh_token_sealed: string }>(
    "SELECT refresh_token_sealed FROM google_tokens WHERE sub = $1",
    [sub],
  );
  if (rows[0]) {
    try {
      await revokeToken(open(rows[0].refresh_token_sealed, sealContext(sub, "refresh")));
    } catch {
      // A token sealed with a retired key can't be revoked by us; deleting it still ends our access.
    }
  }
  await query("DELETE FROM google_tokens WHERE sub = $1", [sub]);
  await query("DELETE FROM sessions WHERE sub = $1", [sub]);
}

/** Ends one session. When it was the user's last one, the Google grant is revoked too. */
export async function signOut(id: string): Promise<void> {
  const session = await readSession(id);
  await deleteSession(id);
  if (!session) return;
  const remaining = await query("SELECT 1 FROM sessions WHERE sub = $1 LIMIT 1", [session.sub]);
  if (remaining.length === 0) await disconnectGoogle(session.sub);
}

const inflight = new Map<string, Promise<string | null>>();

/**
 * A current Google access token for `sub`, refreshing it server-side when it is
 * close to expiry. Concurrent callers share one refresh in this process, and a
 * row lock stops two instances refreshing at once. Background jobs use this too.
 */
export function accessTokenFor(sub: string): Promise<string | null> {
  const pending = inflight.get(sub);
  if (pending) return pending;
  const work = loadOrRefresh(sub).finally(() => inflight.delete(sub));
  inflight.set(sub, work);
  return work;
}

async function loadOrRefresh(sub: string): Promise<string | null> {
  const fresh = (expiresAt: Date | null) => expiresAt !== null && expiresAt.getTime() - EXPIRY_MARGIN_MS > Date.now();

  const cached = await query<{ access_token_sealed: string | null; access_expires_at: Date | null }>(
    "SELECT access_token_sealed, access_expires_at FROM google_tokens WHERE sub = $1",
    [sub],
  );
  if (!cached[0]) return null;
  if (cached[0].access_token_sealed && fresh(cached[0].access_expires_at)) {
    void query("UPDATE google_tokens SET last_used_at = now() WHERE sub = $1", [sub]).catch(() => undefined);
    return open(cached[0].access_token_sealed, sealContext(sub, "access"));
  }

  return transaction(async (client) => {
    const { rows } = await client.query<{
      refresh_token_sealed: string;
      access_token_sealed: string | null;
      access_expires_at: Date | null;
    }>("SELECT refresh_token_sealed, access_token_sealed, access_expires_at FROM google_tokens WHERE sub = $1 FOR UPDATE", [sub]);
    const row = rows[0];
    if (!row) return null;
    // Another instance may have refreshed while we waited for the lock.
    if (row.access_token_sealed && fresh(row.access_expires_at)) {
      return open(row.access_token_sealed, sealContext(sub, "access"));
    }
    let grant: GoogleGrant;
    try {
      grant = await refreshAccessToken(open(row.refresh_token_sealed, sealContext(sub, "refresh")));
    } catch (error) {
      if (error instanceof Error && (error.message === "400" || error.message === "401")) {
        // The user revoked access at Google: forget the grant so they are asked to sign in again.
        await client.query("DELETE FROM google_tokens WHERE sub = $1", [sub]);
        return null;
      }
      throw error;
    }
    const expiresAt = new Date(Date.now() + grant.expiresInSeconds * 1000);
    await client.query(
      `UPDATE google_tokens SET access_token_sealed = $2, access_expires_at = $3, last_used_at = now()
         ${grant.refreshToken ? ", refresh_token_sealed = $4" : ""}
       WHERE sub = $1`,
      grant.refreshToken
        ? [sub, seal(grant.accessToken, sealContext(sub, "access")), expiresAt, seal(grant.refreshToken, sealContext(sub, "refresh"))]
        : [sub, seal(grant.accessToken, sealContext(sub, "access")), expiresAt],
    );
    return grant.accessToken;
  });
}
