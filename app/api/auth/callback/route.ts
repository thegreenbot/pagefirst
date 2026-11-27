import { NextResponse, type NextRequest } from "next/server";
import { createSession, saveGrant } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { exchangeCode } from "@/lib/google/oauth";
import { fetchGoogleIdentity } from "@/lib/google/userinfo";
import { clearPkce, getPkce, serverSessionsEnabled, setAccessToken, setSessionCookie } from "@/lib/session";

export async function GET(request: NextRequest) {
  const origin = oauthOrigin(request);
  const fail = async () => {
    await clearPkce();
    return NextResponse.redirect(new URL("/?google=error", origin));
  };

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const stored = await getPkce();
  if (!code || !state || !stored.verifier || state !== stored.state) return fail();

  try {
    const grant = await exchangeCode({ origin, code, verifier: stored.verifier });
    if (serverSessionsEnabled()) {
      // Tokens stay on the server; the browser only gets an opaque session id.
      const identity = await fetchGoogleIdentity(grant.accessToken);
      if (!identity) return fail();
      await saveGrant(identity.sub, identity.email, grant);
      const sessionId = await createSession(identity.sub, request.headers.get("user-agent"));
      await setSessionCookie(sessionId);
    } else {
      await setAccessToken(grant.accessToken);
    }
    await clearPkce();
    return NextResponse.redirect(new URL("/", origin));
  } catch {
    return fail();
  }
}
