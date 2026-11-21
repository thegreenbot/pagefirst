import { NextResponse, type NextRequest } from "next/server";
import { clearAccessToken } from "@/lib/session";

export async function POST(request: NextRequest) {
  await clearAccessToken();
  return NextResponse.redirect(new URL("/", request.nextUrl.origin), 303);
}
