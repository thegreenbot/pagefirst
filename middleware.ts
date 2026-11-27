import { NextResponse, type NextRequest } from "next/server";
import { checkMutation } from "@/lib/http/csrf";
import { appContentSecurityPolicy, createNonce } from "@/lib/http/headers";

/**
 * `/api/*`: every non-GET route is cookie-authenticated, so each one gets the
 * same cross-site and content-type checks before its handler runs. API-key
 * callers (later) will skip the origin check here, never the rate limit.
 *
 * Pages: a fresh CSP nonce per request. Next.js reads the policy from the
 * request headers and puts the nonce on its own scripts.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/api/")) {
    const verdict = checkMutation(request, pathname);
    if (verdict.ok) return NextResponse.next();
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  }

  const nonce = createNonce();
  const policy = appContentSecurityPolicy(nonce, { dev: process.env.NODE_ENV === "development" });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    "/api/:path*",
    // Pages only: skip static assets and published previews, which set their own policy.
    {
      source: "/((?!api/|_next/static|_next/image|favicon.ico|published/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
