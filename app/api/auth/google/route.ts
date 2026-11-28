import { NextResponse, type NextRequest } from "next/server";
import { googleConfigured } from "@/lib/google/config";
import { oauthOrigin } from "@/lib/google/origin";
import { buildAuthUrl, createPkce } from "@/lib/google/oauth";
import { safeReturnPath, serverSessionsEnabled, setPkce, setReturnTo } from "@/lib/session";

export async function GET(request: NextRequest) {
  const origin = oauthOrigin(request);
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?google=unconfigured", origin));
  }
  const returnTo = safeReturnPath(request.nextUrl.searchParams.get("return"));
  if (returnTo) await setReturnTo(returnTo);
  const { verifier, state } = createPkce();
  await setPkce(verifier, state);
  return NextResponse.redirect(buildAuthUrl({ origin, state, verifier, offline: serverSessionsEnabled() }));
}
