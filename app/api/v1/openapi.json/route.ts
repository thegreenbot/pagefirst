import { NextResponse } from "next/server";
import { openapi } from "@/lib/api/openapi";

/** The public contract; no credential needed to read it. */
export function GET() {
  return NextResponse.json(openapi, { headers: { "Cache-Control": "public, max-age=300" } });
}
