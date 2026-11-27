import { NextResponse } from "next/server";
import { listSessions } from "@/lib/auth/server-sessions";
import { getSessionId, getSessionSub } from "@/lib/session";

export const dynamic = "force-dynamic";

/** The signed-in user's sessions, newest activity first. */
export async function GET() {
  const sub = await getSessionSub();
  if (!sub) return NextResponse.json({ error: "Sign in with Google to see your sessions." }, { status: 401 });
  return NextResponse.json({ sessions: await listSessions(sub, await getSessionId()) });
}
