type OriginRequest = {
  nextUrl: { origin: string; hostname: string };
};

/**
 * The origin used for OAuth redirects and cookie security: APP_URL when set,
 * otherwise the request's own origin. Vercel hosts are always https, even
 * when a proxy marks the upstream request http.
 */
export function oauthOrigin(request: OriginRequest): string {
  const configured = configuredAppUrl();
  if (configured) return configured;
  const hostname = request.nextUrl.hostname.toLowerCase();
  if (isVercelHost(hostname)) return `https://${hostname}`;
  return request.nextUrl.origin;
}

export function oauthOriginFromHeaders(headerList: { get(name: string): string | null }): string {
  const host = headerList.get("host")?.split(",")[0]?.trim() ?? "";
  const hostname = hostnameFrom(host);
  const forwarded = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded || "http";
  const origin = host ? `${proto}://${host}` : "http://localhost";
  return oauthOrigin({ nextUrl: { origin, hostname } });
}

export function callbackUrl(origin: string): string {
  return `${origin}/api/auth/callback`;
}

function isVercelHost(hostname: string): boolean {
  return hostname.endsWith(".vercel.app");
}

function configuredAppUrl(): string | undefined {
  const value = process.env.APP_URL?.trim().replace(/\/+$/, "");
  return value ? value : undefined;
}

function hostnameFrom(host: string): string {
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return (end === -1 ? host : host.slice(1, end)).toLowerCase();
  }
  return (host.split(":")[0] ?? "").toLowerCase();
}
