import { NextResponse } from "next/server";
import { authenticateBearer, unauthorizedHeaders } from "@/lib/api-auth";
import { checkRateLimit, withRateLimit, tooManyRequests } from "@/lib/guard";

export const dynamic = "force-dynamic";

/** Who an API key is and what it may do. A cheap way for a script to test its credential. */
export async function GET(request: Request) {
  const auth = await authenticateBearer(request);
  if (!auth.ok) {
    return NextResponse.json({ error: { code: auth.code, message: auth.error } }, { status: auth.status, headers: unauthorizedHeaders });
  }
  const limit = await checkRateLimit("me", `key:${auth.credential.id}`, 60, "api");
  if (!limit.ok) return tooManyRequests("Too many requests.", limit);
  return withRateLimit(
    NextResponse.json({
      credential: auth.credential,
      scopes: [...(auth.ctx.scopes ?? [])],
      siteFolders: auth.ctx.siteFolders ?? null,
    }),
    limit,
  );
}
