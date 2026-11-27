import { NextResponse, type NextRequest } from "next/server";
import { checkMutation } from "@/lib/http/csrf";

/**
 * Every non-GET `/api/*` route is cookie-authenticated, so each one gets the
 * same cross-site and content-type checks before its handler runs.
 * API-key callers (later) will skip the origin check here, never the rate limit.
 */
export function middleware(request: NextRequest) {
  const verdict = checkMutation(request, request.nextUrl.pathname);
  if (verdict.ok) return NextResponse.next();
  return NextResponse.json({ error: verdict.error }, { status: verdict.status });
}

export const config = {
  matcher: "/api/:path*",
};
