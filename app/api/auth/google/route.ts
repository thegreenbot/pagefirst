import { NextResponse, type NextRequest } from "next/server";
import { googleConfigured } from "@/lib/google/config";
import { buildAuthUrl, createPkce } from "@/lib/google/oauth";
import { setPkce } from "@/lib/session";

export async function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  if (!googleConfigured()) {
    return NextResponse.redirect(new URL("/?google=unconfigured", origin));
  }
  const { verifier, state } = createPkce();
  await setPkce(verifier, state);
  return NextResponse.redirect(buildAuthUrl({ origin, state, verifier }));
}
