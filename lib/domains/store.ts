import { randomBytes } from "node:crypto";
import { query } from "@/lib/db/client";

/**
 * A site's custom domains (#183). Only the site's owner can add or remove one,
 * and a hostname belongs to one site at a time. Whether a domain serves traffic
 * is decided by its status, which the domain service (#186) moves.
 */

export type DomainStatus = "pending" | "verifying" | "active" | "error" | "removed";

export type SiteDomain = {
  id: string;
  siteId: string;
  hostname: string;
  status: DomainStatus;
  verificationToken: string;
  providerRef: string | null;
  lastError: string | null;
  createdAt: string;
  verifiedAt: string | null;
  removedAt: string | null;
};

export class DomainError extends Error {
  constructor(
    readonly code: "not_found" | "taken",
    message: string,
  ) {
    super(message);
  }
}

type Row = {
  id: string;
  site_id: string;
  hostname: string;
  status: DomainStatus;
  verification_token: string;
  provider_ref: string | null;
  last_error: string | null;
  created_at: Date;
  verified_at: Date | null;
  removed_at: Date | null;
};

const COLUMNS = "id, site_id, hostname, status, verification_token, provider_ref, last_error, created_at, verified_at, removed_at";

const iso = (value: Date | null) => (value ? value.toISOString() : null);

function toDomain(row: Row): SiteDomain {
  return {
    id: row.id,
    siteId: row.site_id,
    hostname: row.hostname,
    status: row.status,
    verificationToken: row.verification_token,
    providerRef: row.provider_ref,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    verifiedAt: iso(row.verified_at),
    removedAt: iso(row.removed_at),
  };
}

async function requireOwnedSite(ownerSub: string, siteId: string): Promise<void> {
  const rows = await query("SELECT 1 FROM sites WHERE id = $1 AND owner_sub = $2", [siteId, ownerSub]);
  if (rows.length === 0) throw new DomainError("not_found", "Site not found");
}

/** Adds a pending domain. `hostname` must already be normalized (see hostname.ts). */
export async function createDomain(ownerSub: string, siteId: string, hostname: string): Promise<SiteDomain> {
  await requireOwnedSite(ownerSub, siteId);
  try {
    const rows = await query<Row>(
      `INSERT INTO site_domains (site_id, hostname, verification_token) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [siteId, hostname, randomBytes(24).toString("hex")],
    );
    return toDomain(rows[0]!);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new DomainError("taken", "That domain is already in use");
    throw error;
  }
}

/** The site's domains that have not been removed, oldest first. */
export async function listDomains(ownerSub: string, siteId: string): Promise<SiteDomain[]> {
  await requireOwnedSite(ownerSub, siteId);
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM site_domains WHERE site_id = $1 AND status <> 'removed' ORDER BY created_at, id`,
    [siteId],
  );
  return rows.map(toDomain);
}

/** The domain currently holding a hostname, whatever its status, or null. */
export async function findHeldDomain(hostname: string): Promise<SiteDomain | null> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM site_domains WHERE hostname = $1 AND status <> 'removed'`, [hostname]);
  return rows[0] ? toDomain(rows[0]) : null;
}

export async function countDomains(ownerSub: string, siteId: string): Promise<{ site: number; account: number }> {
  await requireOwnedSite(ownerSub, siteId);
  const [site] = await query<{ count: string }>("SELECT count(*) FROM site_domains WHERE site_id = $1 AND status <> 'removed'", [siteId]);
  const [account] = await query<{ count: string }>(
    `SELECT count(*) FROM site_domains d JOIN sites s ON s.id = d.site_id WHERE s.owner_sub = $1 AND d.status <> 'removed'`,
    [ownerSub],
  );
  return { site: Number(site?.count ?? 0), account: Number(account?.count ?? 0) };
}

/** Moves a domain along its lifecycle. Removed domains stay removed. Used by the domain service. */
export async function setDomainStatus(
  id: string,
  status: DomainStatus,
  fields: { error?: string | null; providerRef?: string | null } = {},
): Promise<SiteDomain | null> {
  const rows = await query<Row>(
    `UPDATE site_domains SET
       status = $2,
       last_error = CASE WHEN $2 = 'error' THEN $3 ELSE NULL END,
       provider_ref = COALESCE($4, provider_ref),
       verified_at = CASE WHEN $2 = 'active' AND verified_at IS NULL THEN now() ELSE verified_at END,
       removed_at = CASE WHEN $2 = 'removed' THEN now() ELSE removed_at END
     WHERE id = $1 AND status <> 'removed'
     RETURNING ${COLUMNS}`,
    [id, status, fields.error ?? null, fields.providerRef ?? null],
  );
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Marks the owner's domain removed, freeing the hostname. Returns it, or throws not_found. */
export async function removeDomain(ownerSub: string, siteId: string, id: string): Promise<SiteDomain> {
  await requireOwnedSite(ownerSub, siteId);
  const rows = await query<Row>(
    `UPDATE site_domains SET status = 'removed', removed_at = now() WHERE id = $1 AND site_id = $2 AND status <> 'removed' RETURNING ${COLUMNS}`,
    [id, siteId],
  );
  if (!rows[0]) throw new DomainError("not_found", "Domain not found");
  return toDomain(rows[0]);
}

/** One of the site's domains that has not been removed, or null. */
export async function getDomain(ownerSub: string, siteId: string, id: string): Promise<SiteDomain | null> {
  await requireOwnedSite(ownerSub, siteId);
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM site_domains WHERE id = $1 AND site_id = $2 AND status <> 'removed'`, [id, siteId]);
  return rows[0] ? toDomain(rows[0]) : null;
}

/** Domains in the given states, least recently created first, for the re-verification sweep. */
export async function listDomainsByStatus(statuses: DomainStatus[], limit: number): Promise<SiteDomain[]> {
  const rows = await query<Row>(
    `SELECT ${COLUMNS} FROM site_domains WHERE status = ANY($1::text[]) ORDER BY created_at, id LIMIT $2`,
    [statuses, limit],
  );
  return rows.map(toDomain);
}
