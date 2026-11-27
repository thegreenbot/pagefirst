/**
 * Cross-site request checks for cookie-authenticated mutating routes.
 * No Node-only imports: this file also runs in middleware.
 */

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Routes authenticated by a bearer token only, never a cookie, so a cross-site
 * request gains nothing: the theme registry's trusted-publishing upload (#64),
 * called from GitHub Actions with an OIDC token, and the versioned API, which
 * authenticates with an API key or OAuth token and ignores cookies (#36).
 */
const TOKEN_ROUTES = [/^\/api\/registry\/versions$/, /^\/api\/v1\//];

/** Routes whose body, when there is one, must be JSON. */
const JSON_ROUTES = [/^\/api\/pages\/[^/]+\/commit$/, /^\/api\/pages\/[^/]+\/publish$/, /^\/api\/keys$/, ...TOKEN_ROUTES];

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
  return type === "application/json";
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
  const tokenRoute = TOKEN_ROUTES.some((pattern) => pattern.test(pathname));
  if (!tokenRoute && !sameOrigin(request)) {
    return { ok: false, status: 403, error: "Cross-site request refused." };
  }
  if (isJsonRoute(pathname) && hasBody(request) && !isJsonContentType(request.headers.get("content-type"))) {
    return { ok: false, status: 415, error: "Send this request as application/json." };
  }
  return { ok: true };
}
