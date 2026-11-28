/**
 * The Cloudflare Worker that serves every published site from one R2 bucket
 * (#94). It imports nothing from the app, so `worker/index.ts` can bundle it
 * alone. Layout in the bucket:
 *
 *   hosts/<hostname>          → the siteId that hostname serves (text)
 *   canonical/<siteId>        → the custom hostname that site prefers (text); other hosts redirect to it
 *   sites/<siteId>/<file>     → that site's files, with `csp` in customMetadata
 *
 * A request maps hostname → siteId → file. Nothing a visitor sends can name
 * another site's folder: the siteId only ever comes from the hosts/ record.
 */

export type R2ObjectBody = {
  body: ReadableStream | null;
  httpEtag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
};

export type R2BucketLike = {
  get(key: string): Promise<R2ObjectBody | null>;
};

export type SiteWorkerEnv = {
  SITES: R2BucketLike;
};

/** Used when a file has no stored policy: no script, nothing from elsewhere but images. */
export const DEFAULT_SITE_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const SITE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const HOSTNAME = /^[a-z0-9.-]{1,253}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const BASE_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
  "X-Frame-Options": "DENY",
};

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The bucket keys to try for a URL path, in order, or null when the path is
 * not one a site can have. "/" → index.html; "/a/b" → a/b.html, a/b/index.html;
 * "/a/logo.png" → a/logo.png.
 */
export function candidateKeys(pathname: string): string[] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const segments = decoded.split("/").filter((segment) => segment !== "");
  if (segments.length > 16 || !segments.every((segment) => SEGMENT.test(segment) && !segment.startsWith(".."))) return null;
  if (segments.length === 0) return ["index.html"];
  const joined = segments.join("/");
  const last = segments[segments.length - 1]!;
  if (/\.[A-Za-z0-9]{1,8}$/.test(last)) return [joined];
  return [`${joined}.html`, `${joined}/index.html`];
}

/**
 * Pages change on republish; files under assets/ are content addressed (deferred
 * CSS, island modules, image renditions), so their bytes never change.
 */
export function cacheControl(key: string): string {
  if (key.endsWith(".html")) return "public, max-age=60";
  if (key.startsWith("assets/pf/") || key.startsWith("assets/img/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

export async function siteIdFor(env: SiteWorkerEnv, hostname: string): Promise<string | null> {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME.test(host)) return null;
  const record = await env.SITES.get(`hosts/${host}`);
  if (!record) return null;
  const siteId = (await record.text()).trim();
  return SITE_ID.test(siteId) ? siteId : null;
}

/** The custom hostname a site prefers, or null when it has none (or the record is malformed). */
export async function canonicalHostFor(env: SiteWorkerEnv, siteId: string): Promise<string | null> {
  const record = await env.SITES.get(`canonical/${siteId}`);
  if (!record) return null;
  const host = (await record.text()).trim().toLowerCase();
  return HOSTNAME.test(host) && host.includes(".") ? host : null;
}

/** Speculation Rules (#63): prefetch same-site pages a visitor is about to open. */
export const SPECULATION_RULES_PATH = "/_pf/speculation-rules.json";
export const SPECULATION_RULES = JSON.stringify({
  prefetch: [{ source: "document", where: { href_matches: "/*" }, eagerness: "moderate" }],
});

export async function handleSiteRequest(request: Request, env: SiteWorkerEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    const response = plain(405, "Method not allowed");
    response.headers.set("Allow", "GET, HEAD");
    return response;
  }
  const url = new URL(request.url);
  const siteId = await siteIdFor(env, url.hostname);
  if (!siteId) return plain(404, "No site is published at this address.");
  // A site with an active custom domain lives there; its other addresses send visitors on, keeping path and query.
  const canonical = await canonicalHostFor(env, siteId);
  if (canonical && canonical !== url.hostname.toLowerCase().replace(/\.$/, "")) {
    const response = plain(301, "");
    response.headers.set("Location", `https://${canonical}${url.pathname}${url.search}`);
    response.headers.set("Cache-Control", "public, max-age=300");
    return response;
  }
  if (url.pathname === SPECULATION_RULES_PATH) {
    // No site file can live here: path segments must start with a letter or digit.
    return new Response(request.method === "HEAD" ? null : SPECULATION_RULES, {
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "application/speculationrules+json",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "Cache-Control": "public, max-age=86400",
      },
    });
  }
  const keys = candidateKeys(url.pathname);
  if (!keys) return plain(404, "Not found");

  for (const key of keys) {
    const object = await env.SITES.get(`sites/${siteId}/${key}`);
    if (!object) continue;
    const csp = object.customMetadata?.csp || DEFAULT_SITE_CSP;
    const headers = new Headers({
      ...BASE_HEADERS,
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Security-Policy": `${csp}; frame-ancestors 'none'`,
      ETag: object.httpEtag,
      "Cache-Control": cacheControl(key),
    });
    if (key.endsWith(".html")) {
      headers.set("Speculation-Rules", `"${SPECULATION_RULES_PATH}"`);
      // Preloads stored at publish time; Cloudflare sends them as 103 Early Hints.
      const link = object.customMetadata?.link;
      if (link && !/[\r\n]/.test(link)) headers.set("Link", link);
    }
    if (request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    return new Response(request.method === "HEAD" ? null : object.body, { headers });
  }
  return plain(404, "Not found");
}

const worker = { fetch: handleSiteRequest };
export default worker;
