import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { readTextCapped } from "@/lib/http/body";
import { ConfigError, siteForOwner } from "./theme-config";

const MAX_BODY = 512 * 1024;

/** The caller's site, or the response to send instead. Site settings need a signed-in owner and Postgres. */
export async function requireSite(request: Request, bucket: string): Promise<{ ok: true; siteId: string } | { ok: false; response: NextResponse }> {
  const writer = await requireGoogleWriter();
  if (!writer.ok) return { ok: false, response: NextResponse.json({ error: writer.error }, { status: 401 }) };
  if (!writer.sub || !databaseConfigured()) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Theme settings are saved per site, which needs a signed-in account." }, { status: 409 }),
    };
  }
  const limit = await checkRateLimit(bucket, callerKey(writer.token, request, writer.sub), 60);
  if (!limit.ok) return { ok: false, response: tooManyRequests("Too many changes. Wait a moment.", limit) };
  return { ok: true, siteId: await siteForOwner(writer.sub) };
}

export async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: NextResponse }> {
  const read = await readTextCapped(request, MAX_BODY);
  if (!read.ok) return { ok: false, response: NextResponse.json({ error: "Request is too large" }, { status: 413 }) };
  try {
    return { ok: true, body: JSON.parse(read.text) };
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) };
  }
}

export function configErrorResponse(error: unknown): NextResponse {
  if (error instanceof ConfigError) return NextResponse.json({ error: error.message, path: error.path }, { status: 400 });
  throw error;
}
