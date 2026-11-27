import { NextResponse, type NextRequest } from "next/server";
import { auditAdmins, auditEventsBetween, auditEventsFor } from "@/lib/audit";
import { databaseConfigured } from "@/lib/db/client";
import { accessTokenFor } from "@/lib/auth/server-sessions";
import { fetchGoogleIdentity } from "@/lib/google/userinfo";
import { getSessionSub } from "@/lib/session";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/**
 * GET /api/audit: the signed-in account's own activity (newest first).
 * GET /api/audit?from=…&to=…: every event in the range, for AUDIT_ADMIN_EMAILS only (max 31 days).
 */
export async function GET(request: NextRequest) {
  if (!databaseConfigured()) {
    return NextResponse.json({ error: "The audit log needs a database." }, { status: 404 });
  }
  const sub = await getSessionSub();
  if (!sub) return NextResponse.json({ error: "Sign in with Google to see activity." }, { status: 401 });

  const params = request.nextUrl.searchParams;
  if (!params.has("from") && !params.has("to")) {
    const limit = Number(params.get("limit") ?? 100);
    const events = await auditEventsFor(sub, Number.isFinite(limit) ? limit : 100);
    return NextResponse.json({ events });
  }

  const token = await accessTokenFor(sub);
  const identity = token ? await fetchGoogleIdentity(token) : null;
  if (!identity?.email || !auditAdmins().has(identity.email)) {
    return NextResponse.json({ error: "Only audit admins can export every account's events." }, { status: 403 });
  }
  const from = new Date(params.get("from") ?? "");
  const to = new Date(params.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > 31 * DAY_MS) {
    return NextResponse.json({ error: "from and to must be dates at most 31 days apart." }, { status: 400 });
  }
  const events = await auditEventsBetween(from, to);
  return NextResponse.json({ events });
}
