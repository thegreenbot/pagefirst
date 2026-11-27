import { randomInt } from "node:crypto";
import { databaseConfigured, query } from "@/lib/db/client";
import { putHost, putSiteAsset, putSitePage, r2Configured } from "@/lib/publish/r2";
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
  assets: { path: string; contentType: string; body: string }[];
};

/** Writes one page (and its assets) to the owner's site and returns the page's public URL. */
export async function publishToOwnSite(
  ownerSub: string,
  pagePath: string,
  page: SitePublish,
): Promise<{ siteId: string; url: string }> {
  const siteId = await siteForOwner(ownerSub);
  const hostname = await siteHostname(siteId);
  await putHost(hostname, siteId);
  for (const asset of page.assets) await putSiteAsset(siteId, asset.path, asset.body, asset.contentType);
  await putSitePage(siteId, pagePath, page.html, page.csp);
  const path = pagePath.replace(/^\/+/, "");
  return { siteId, url: `https://${hostname}/${path === "index" ? "" : path}` };
}
