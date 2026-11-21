import { NextResponse, type NextRequest } from "next/server";
import { oauthOrigin } from "@/lib/google/origin";
import { clearAccessToken } from "@/lib/session";

export async function POST(request: NextRequest) {
  await clearAccessToken();
  return NextResponse.redirect(new URL("/", oauthOrigin(request)), 303);
}
