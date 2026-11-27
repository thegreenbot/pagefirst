import { NextResponse, type NextRequest } from "next/server";
import { disconnectGoogle } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { clearSessionCookies, getSessionSub } from "@/lib/session";

/** "Sign out everywhere": revokes the Google grant and ends every session for this account. */
export async function POST(request: NextRequest) {
  const sub = await getSessionSub();
  if (sub) await disconnectGoogle(sub);
  await clearSessionCookies();
  return NextResponse.redirect(new URL("/", oauthOrigin(request)), 303);
}
