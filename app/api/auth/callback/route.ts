import { NextResponse, type NextRequest } from "next/server";
import { createSession, saveGrant } from "@/lib/auth/server-sessions";
import { oauthOrigin } from "@/lib/google/origin";
import { exchangeCode } from "@/lib/google/oauth";
import { fetchGoogleIdentity } from "@/lib/google/userinfo";
import { auditRequest } from "@/lib/audit-request";
import { claimPendingMemberships } from "@/lib/tenant/orgs";
import { clearPkce, getPkce, serverSessionsEnabled, setAccessToken, setSessionCookie, takeReturnTo } from "@/lib/session";

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
      await saveGrant(identity.sub, identity.email, grant, identity.hd);
      if (identity.email) await claimPendingMemberships(identity.sub, identity.email, identity.hd).catch(() => undefined);
      const sessionId = await createSession(identity.sub, request.headers.get("user-agent"));
      await setSessionCookie(sessionId);
      await auditRequest(request, { event: "auth.sign_in", outcome: "ok", actorSub: identity.sub, status: 302 });
    } else {
      await setAccessToken(grant.accessToken);
      await auditRequest(request, { event: "auth.sign_in", outcome: "ok", actorSub: null, status: 302 });
    }
    await clearPkce();
    return NextResponse.redirect(new URL((await takeReturnTo()) ?? "/", origin));
  } catch {
    return fail();
  }
}
