import { NextResponse, type NextRequest } from "next/server";
import { signOut } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { revokeToken } from "@/lib/google/oauth";
import { auditRequest } from "@/lib/audit-request";
import { clearSessionCookies, getLegacyAccessToken, getSessionId, getSessionSub, serverSessionsEnabled } from "@/lib/session";

/** Ends this session. When it was the last one, the Google grant is revoked and deleted. */
export async function POST(request: NextRequest) {
  const sessionId = await getSessionId();
  const sub = await getSessionSub();
  if (sessionId && serverSessionsEnabled()) await signOut(sessionId);
  const legacy = await getLegacyAccessToken();
  if (legacy) await revokeToken(legacy);
  await clearSessionCookies();
  await auditRequest(request, { event: "auth.sign_out", outcome: "ok", actorSub: sub, status: 303 });
  return NextResponse.redirect(new URL("/", oauthOrigin(request)), 303);
}
