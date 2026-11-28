import { NextResponse } from "next/server";
import { pickerConfig } from "@/lib/google/config";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { sameOrigin } from "@/lib/http/csrf";

export const dynamic = "force-dynamic";

/**
 * What the browser needs to open the Google Picker (#15): the public API key,
 * the Cloud project number, and the signed-in person's own access token.
 * The Picker runs in the browser and cannot use a server session, so this is
 * the one place a token leaves the server. It is the caller's own token,
 * limited to the scopes they consented to (drive.file in narrow mode), and
 * is only handed to a same-origin request.
 */
export async function GET(request: Request) {
  const config = pickerConfig();
  if (!config) return NextResponse.json({ error: "The Google Picker is not configured." }, { status: 503 });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin request refused." }, { status: 403 });
  const writer = await requireGoogleWriter();
  if (!writer.ok || !writer.token) return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
  const limit = await checkRateLimit("google.picker", callerKey(writer.token, request, writer.sub), 30);
  if (!limit.ok) return tooManyRequests("Too many requests.", limit);
  return NextResponse.json({ ...config, accessToken: writer.token }, { headers: { "Cache-Control": "no-store" } });
}
