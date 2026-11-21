export const PUBLIC_APP_ORIGIN = "https://page-first.apps.grok.bot";

const PUBLIC_APP_HOST = new URL(PUBLIC_APP_ORIGIN).host;

type OriginRequest = {
  nextUrl: { origin: string; hostname: string };
};

/** APP_URL when set, otherwise the public app on *.vercel.app, otherwise the request origin. */
export function oauthOrigin(request: OriginRequest): string {
  const configured = configuredAppUrl();
  if (configured) return configured;
  if (request.nextUrl.hostname.toLowerCase().endsWith(".vercel.app")) {
    return PUBLIC_APP_ORIGIN;
  }
  return request.nextUrl.origin;
}

export function oauthOriginFromHeaders(headerList: { get(name: string): string | null }): string {
  const host = headerList.get("host")?.split(",")[0]?.trim() ?? "";
  const hostname = hostnameFrom(host);
  // The public app is https even when a proxy marks the upstream request http.
  if (hostname === PUBLIC_APP_HOST || hostname.endsWith(".vercel.app")) {
    return oauthOrigin({ nextUrl: { origin: PUBLIC_APP_ORIGIN, hostname } });
  }
  const forwarded = headerList.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const proto = forwarded || "http";
  const origin = host ? `${proto}://${host}` : "http://localhost";
  return oauthOrigin({ nextUrl: { origin, hostname } });
}

export function callbackUrl(origin: string): string {
  return `${origin}/api/auth/callback`;
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
