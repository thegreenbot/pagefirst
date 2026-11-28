/**
 * Cross-site request checks for cookie-authenticated mutating routes.
 * No Node-only imports: this file also runs in middleware.
 */

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes authenticated by a bearer token only, never a cookie, so a cross-site
 * request gains nothing: the theme registry's trusted-publishing upload (#64),
 * called from GitHub Actions with an OIDC token, the versioned API and the MCP server on top of it, which
 * authenticates with an API key or OAuth token and ignores cookies (#36), SCIM
 * provisioning with a per-organization bearer token (#49), and the Stripe
 * webhook, which is authenticated by its signature over the body (#47).
 */
const TOKEN_ROUTES = [/^\/api\/registry\/versions$/, /^\/api\/v1\//, /^\/api\/mcp$/, /^\/api\/oauth\/register$/, /^\/api\/billing\/webhook$/, /^\/api\/scim\/v2\//];

/**
 * The speed beacon's collector (#70) is posted by visitors of published sites,
 * from another origin and with no cookie. It reads no session and only counts
 * numbers, so it skips the origin check; it takes `text/plain` on purpose.
 */
const BEACON_ROUTES = [/^\/api\/vitals$/];

/** Public OAuth endpoints that read no cookie and take form-encoded bodies. */
const FORM_ROUTES = [/^\/api\/oauth\/(token|revoke)$/];

/** Routes whose body, when there is one, must be JSON. */
const JSON_ROUTES = [/^\/api\/billing\/(checkout|portal)$/, /^\/api\/orgs\/[^/]+\/(scim-tokens|domain|theme-policy|themes)$/, /^\/api\/pages\/[^/]+\/commit$/, /^\/api\/pages\/[^/]+\/publish$/, /^\/api\/keys$/, ...TOKEN_ROUTES];

function configuredOrigin(): string | null {
  const value = process.env.APP_URL?.trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * True when the browser says the request came from this app. Trusts
 * `Sec-Fetch-Site` first, then compares `Origin` with the request host or APP_URL.
 * A request with neither header is refused.
 */
export function sameOrigin(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site === "same-origin" || site === "none") return true;
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  try {
    if (parsed.host === new URL(request.url).host) return true;
  } catch {
    // fall through to APP_URL
  }
  return parsed.origin === configuredOrigin();
}

export function isJsonRoute(pathname: string): boolean {
  return JSON_ROUTES.some((pattern) => pattern.test(pathname));
}

function hasBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  if (length !== null) return length.trim() !== "0";
  return request.body !== null || request.headers.has("transfer-encoding");
}

export function isJsonContentType(value: string | null): boolean {
  const type = value?.split(";")[0]?.trim().toLowerCase();
  return type === "application/json" || type === "application/scim+json";
}

export type MutationCheck = { ok: true } | { ok: false; status: 403 | 415; error: string };

/**
 * Checks a request to a cookie-authenticated `/api/*` route before the handler runs.
 * Safe methods pass. Anything else must be same-origin, and a JSON route's body
 * must be sent as `application/json`, which a cross-site form or `text/plain`
 * fetch cannot do without a CORS preflight.
 */
export function checkMutation(request: Request, pathname: string): MutationCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };
  const tokenRoute = TOKEN_ROUTES.some((pattern) => pattern.test(pathname)) || FORM_ROUTES.some((pattern) => pattern.test(pathname)) || BEACON_ROUTES.some((pattern) => pattern.test(pathname));
  if (!tokenRoute && !sameOrigin(request)) {
    return { ok: false, status: 403, error: "Cross-site request refused." };
  }
  if (isJsonRoute(pathname) && hasBody(request) && !isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, status: 415, error: "Send this request as application/json." };
  }
  return { ok: true };
}
