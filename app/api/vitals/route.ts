import { NextResponse } from "next/server";
import { readTextCapped } from "@/lib/http/body";
import { callerKey, checkRateLimit } from "@/lib/guard";
import { parseSample, recordSample } from "@/lib/site/speed";
import { databaseConfigured } from "@/lib/db/client";

export const dynamic = "force-dynamic";

/** Per visitor address per minute: a visit sends one beacon, so this only stops floods. */
const VITALS_LIMIT = 60;

/**
 * The speed beacon's collector (#70). Public and cookie-free: it reads no
 * session, accepts only a site id, a path and up to three numbers, and answers
 * 204 whatever it did with them, so it reveals nothing about which sites exist.
 * The beacon sends `text/plain`, which a browser posts cross-site without a preflight.
 */
export async function POST(request: Request) {
  if (!databaseConfigured()) return new NextResponse(null, { status: 204 });
  const limit = await checkRateLimit("vitals", callerKey(null, request), VITALS_LIMIT);
  if (!limit.ok) return new NextResponse(null, { status: 429 });
  const read = await readTextCapped(request, 512);
  if (!read.ok) return new NextResponse(null, { status: 413 });
  const sample = parseSample(read.text);
  if (sample) await recordSample(sample).catch(() => false);
  return new NextResponse(null, { status: 204 });
}
