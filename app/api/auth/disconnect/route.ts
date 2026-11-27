import { NextResponse, type NextRequest } from "next/server";
import { disconnectGoogle } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { auditRequest } from "@/lib/audit-request";
import { clearSessionCookies, getSessionSub } from "@/lib/session";

/** "Sign out everywhere": revokes the Google grant and ends every session for this account. */
export async function POST(request: NextRequest) {
  const sub = await getSessionSub();
  if (sub) await disconnectGoogle(sub);
  await clearSessionCookies();
  await auditRequest(request, { event: "auth.token_revoked", outcome: "ok", actorSub: sub, status: 303 });
  return NextResponse.redirect(new URL("/", oauthOrigin(request)), 303);
}
