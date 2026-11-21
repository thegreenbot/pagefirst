import { NextResponse, type NextRequest } from "next/server";
import { oauthOrigin } from "@/lib/google/origin";
import { exchangeCode } from "@/lib/google/oauth";
import { clearPkce, getPkce, setAccessToken } from "@/lib/session";

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
    const { accessToken } = await exchangeCode({ origin, code, verifier: stored.verifier });
    await setAccessToken(accessToken);
    await clearPkce();
    return NextResponse.redirect(new URL("/", origin));
  } catch {
    return fail();
  }
}
