import { candidateKeys } from "@/lib/publish/site-worker";

/**
 * Writes published files to the sites bucket through Cloudflare's R2 REST API
 * (#94). The token is scoped to that one bucket. Every key is built here from
 * a validated siteId and path, so a caller can't write outside its folder.
 */

const API = "https://api.cloudflare.com/client/v4";
const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

type R2Config = { accountId: string; bucket: string; token: string };

export function r2Config(): R2Config | null {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const token = process.env.R2_API_TOKEN?.trim();
  return accountId && bucket && token ? { accountId, bucket, token } : null;
}

export function r2Configured(): boolean {
  return r2Config() !== null;
}

/** The bucket key for a page path on a site, e.g. ("s1", "blog/post") → "sites/s1/blog/post.html". */
export function siteObjectKey(siteId: string, pagePath: string): string {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  const keys = candidateKeys(`/${pagePath.replace(/^\/+/, "")}`);
  if (!keys?.[0]) throw new Error("Invalid page path");
  return `sites/${siteId}/${keys[0]}`;
}

export function hostObjectKey(hostname: string): string {
  const host = hostname.toLowerCase();
  if (!HOSTNAME.test(host)) throw new Error("Invalid hostname");
  return `hosts/${host}`;
}

function objectUrl(config: R2Config, key: string): string {
  return `${API}/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/objects/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function send(
  method: "PUT" | "DELETE",
  key: string,
  init: { body?: string | Uint8Array; contentType?: string; csp?: string; link?: string } = {},
): Promise<void> {
  const config = r2Config();
  if (!config) throw new Error("Publishing storage is not configured");
  const headers: Record<string, string> = { Authorization: `Bearer ${config.token}` };
  if (init.contentType) headers["Content-Type"] = init.contentType;
  // R2 stores cf-r2-meta-* headers as customMetadata, which the Worker sends as the page's CSP.
  if (init.csp) headers["cf-r2-meta-csp"] = init.csp;
  // The page's preload Link header (#63), which Cloudflare turns into 103 Early Hints.
  if (init.link) headers["cf-r2-meta-link"] = init.link;
  const response = await fetch(objectUrl(config, key), { method, headers, body: typeof init.body === "object" ? Buffer.from(init.body) : init.body, signal: AbortSignal.timeout(15_000) });
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok && !(method === "DELETE" && response.status === 404)) {
    // The status only: a response body could echo the request.
    throw new Error(`Publishing storage answered ${response.status}`);
  }
}

/** Writes one page of one site. Other pages and other sites are untouched. */
export async function putSitePage(siteId: string, pagePath: string, html: string, csp: string, link = ""): Promise<string> {
  const key = siteObjectKey(siteId, pagePath);
  await send("PUT", key, { body: html, contentType: "text/html; charset=utf-8", csp, link: link || undefined });
  return key;
}

/** Writes a content-addressed asset (deferred CSS, island module, image rendition) a page links to. */
export async function putSiteAsset(siteId: string, assetPath: string, body: string | Uint8Array, contentType: string): Promise<string> {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  const keys = candidateKeys(`/${assetPath}`);
  if (!keys || keys.length !== 1 || !keys[0]) throw new Error("Invalid asset path");
  const key = `sites/${siteId}/${keys[0]}`;
  await send("PUT", key, { body, contentType });
  return key;
}

export async function deleteSitePage(siteId: string, pagePath: string): Promise<void> {
  await send("DELETE", siteObjectKey(siteId, pagePath));
}

/**
 * Removes one file recorded in `site_files`: a bucket key under the site's own
 * folder, a path inside the folder, or `host:<hostname>` for the hostname record.
 * Used when an organization is deleted. A missing object is fine.
 */
export async function removeSiteFile(siteId: string, recorded: string): Promise<void> {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  if (recorded.startsWith("host:")) return send("DELETE", hostObjectKey(recorded.slice(5)));
  if (recorded.startsWith(`sites/${siteId}/`)) return send("DELETE", recorded);
  const keys = candidateKeys(`/${recorded}`);
  if (!keys?.[0]) throw new Error("Invalid recorded path");
  await send("DELETE", `sites/${siteId}/${keys[0]}`);
}

/** Points a hostname at a site. Only called after the app has checked who owns the site. */
export async function putHost(hostname: string, siteId: string): Promise<void> {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  await send("PUT", hostObjectKey(hostname), { body: siteId, contentType: "text/plain; charset=utf-8" });
}

/** Stops serving a hostname. A hostname that is already gone is fine. */
export async function deleteHost(hostname: string): Promise<void> {
  await send("DELETE", hostObjectKey(hostname));
}

/** Records which custom hostname a site prefers; its other addresses redirect there. */
export async function putCanonicalHost(siteId: string, hostname: string): Promise<void> {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  hostObjectKey(hostname);
  await send("PUT", `canonical/${siteId}`, { body: hostname.toLowerCase(), contentType: "text/plain; charset=utf-8" });
}

export async function deleteCanonicalHost(siteId: string): Promise<void> {
  if (!SITE_ID.test(siteId)) throw new Error("Invalid site id");
  await send("DELETE", `canonical/${siteId}`);
}

/** Hostnames that have a record in the bucket, for the orphan sweeper (#190). */
export async function listHostRecords(): Promise<string[]> {
  const config = r2Config();
  if (!config) throw new Error("Publishing storage is not configured");
  const found: string[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page += 1) {
    const url = `${API}/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/objects?prefix=hosts%2F&per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${config.token}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Publishing storage answered ${response.status}`);
    const payload = (await response.json().catch(() => null)) as { result?: { key?: string }[]; result_info?: { cursor?: string; is_truncated?: boolean } } | null;
    for (const object of payload?.result ?? []) if (object.key?.startsWith("hosts/")) found.push(object.key.slice("hosts/".length));
    cursor = payload?.result_info?.is_truncated ? (payload.result_info.cursor ?? "") : "";
    if (!cursor) break;
  }
  return found;
}
