import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { oauthOriginFromHeaders } from "@/lib/google/origin";
import type { OAuthErrorCode } from "./protocol";

/** Public OAuth endpoints carry no cookies, so any origin may call them from a browser. */
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" };

export function preflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...CORS, ...extra } });
}

export function oauthError(error: OAuthErrorCode, description: string, status = 400): NextResponse {
  return json({ error, error_description: description }, status, NO_STORE);
}

export async function issuer(): Promise<string> {
  return oauthOriginFromHeaders(await headers());
}

/** Reads an application/x-www-form-urlencoded body, capped. */
export async function readForm(request: Request, maxBytes = 8_000): Promise<URLSearchParams | null> {
  const text = await request.text();
  if (text.length > maxBytes) return null;
  return new URLSearchParams(text);
}
