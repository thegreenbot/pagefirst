import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { revokeToken } from "@/lib/google/oauth";
import { clearSessionCookies, getLegacyAccessToken, getSessionId, serverSessionsEnabled } from "@/lib/session";

/** Ends this session. When it was the last one, the Google grant is revoked and deleted. */
export async function POST(request: NextRequest) {
  const sessionId = await getSessionId();
  if (sessionId && serverSessionsEnabled()) await signOut(sessionId);
  const legacy = await getLegacyAccessToken();
  if (legacy) await revokeToken(legacy);
  await clearSessionCookies();
  return NextResponse.redirect(new URL("/", oauthOrigin(request)), 303);
}
