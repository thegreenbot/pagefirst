import { createHash, randomInt } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";
import { putHost, putSiteAsset, putSitePage, r2Configured, siteObjectKey } from "@/lib/publish/r2";
import { siteForOwner } from "@/lib/site/theme-config";

/**
 * Public publishing to the caller's own site (#94). The site comes only from
 * the signed-in account, so a caller can never name, change or remove another
 * account's pages: every write lands under sites/<their siteId>/.
 */

const LABEL_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const DOMAIN = /^(?=.{1,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function publishDomain(): string | null {
  const value = process.env.PUBLISH_DOMAIN?.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
  return value && DOMAIN.test(value) ? value : null;
}

/** True when R2, the publish domain and Postgres are all configured. */
export function sitePublishingEnabled(): boolean {
  return r2Configured() && publishDomain() !== null && databaseConfigured();
}

function newLabel(): string {
  let label = "p";
  for (let i = 0; i < 9; i += 1) label += LABEL_ALPHABET[randomInt(LABEL_ALPHABET.length)];
  return label;
}

/** The site's hostname, assigning a random label the first time. */
export async function siteHostname(siteId: string): Promise<string> {
  const domain = publishDomain();
  if (!domain) throw new Error("PUBLISH_DOMAIN is not set");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [current] = await query<{ subdomain: string | null }>("SELECT subdomain FROM sites WHERE id = $1", [siteId]);
    if (!current) throw new Error("Site not found");
    if (current.subdomain) return `${current.subdomain}.${domain}`;
    try {
      await query("UPDATE sites SET subdomain = $2 WHERE id = $1 AND subdomain IS NULL", [siteId, newLabel()]);
    } catch (error) {
      // A label already taken by another site: try another.
      if ((error as { code?: string }).code !== "23505") throw error;
    }
  }
  throw new Error("Could not assign a site address");
}

export type SitePublish = {
  html: string;
  csp: string;
  assets: { path: string; contentType: string; body: string | Uint8Array }[];
  /** Link header values for the page, e.g. the LCP image preload (#63). */
  preloads?: string[];
};

const digest = (...parts: (string | Uint8Array)[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

/** What the site's folder already holds, by key (#63). */
async function knownFiles(siteId: string): Promise<Map<string, string>> {
  const rows = await query<{ key: string; sha256: string }>("SELECT key, sha256 FROM site_files WHERE site_id = $1", [siteId]);
  return new Map(rows.map((row) => [row.key, row.sha256]));
}

async function recordFile(siteId: string, key: string, sha256: string): Promise<void> {
  await query(
    `INSERT INTO site_files (site_id, key, sha256) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key) DO UPDATE SET sha256 = EXCLUDED.sha256, updated_at = now()`,
    [siteId, key, sha256],
  );
}

/**
 * Writes one page (and its assets) to the owner's site and returns the page's
 * public URL. Files the site already holds with the same bytes are skipped, so
 * republishing an unchanged page uploads nothing (#63). Assets go up before
 * the page, so a page never links to a file that is not there yet.
 */
export async function publishToOwnSite(
  ownerSub: string,
  pagePath: string,
  page: SitePublish,
): Promise<{ siteId: string; url: string; uploaded: number }> {
  const siteId = await siteForOwner(ownerSub);
  const hostname = await siteHostname(siteId);
  const known = await knownFiles(siteId);
  let uploaded = 0;
  const put = async (key: string, sha256: string, write: () => Promise<unknown>) => {
    if (known.get(key) === sha256) return;
    await write();
    await recordFile(siteId, key, sha256);
    uploaded += 1;
  };
  await put(`host:${hostname}`, digest(siteId), () => putHost(hostname, siteId));
  for (const asset of page.assets) {
    await put(asset.path, digest(asset.contentType, asset.body), () => putSiteAsset(siteId, asset.path, asset.body, asset.contentType));
  }
  const link = (page.preloads ?? []).join(", ");
  await put(siteObjectKey(siteId, pagePath), digest(page.html, page.csp, link), () => putSitePage(siteId, pagePath, page.html, page.csp, link));
  const path = pagePath.replace(/^\/+/, "");
  return { siteId, url: `https://${hostname}/${path === "index" ? "" : path}`, uploaded };
}
