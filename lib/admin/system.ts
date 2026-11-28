import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";

/**
 * System administrators run the service itself (theme publisher invites,
 * submission review), as opposed to an organization's own admins. They are
 * named in PAGEFIRST_SYSTEM_ADMINS as a comma-separated list of Google
 * account ids (`sub`); nothing in the database can grant the role.
 */
export function systemAdmins(): string[] {
  return (process.env.PAGEFIRST_SYSTEM_ADMINS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
}

export const isSystemAdmin = (sub: string | null | undefined): boolean => !!sub && systemAdmins().includes(sub);

/** The signed-in system administrator, or a response. Everyone else gets a 404 so the routes are not discoverable. */
export async function requireSystemAdmin(request: Request, action: string): Promise<{ sub: string } | NextResponse> {
  const writer = await requireGoogleWriter();
  if (!writer.ok || !writer.sub) return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
  if (!isSystemAdmin(writer.sub)) return NextResponse.json({ error: "Not found." }, { status: 404 });
  if (!databaseConfigured()) return NextResponse.json({ error: "This needs the database." }, { status: 503 });
  const limit = await checkRateLimit(action, callerKey(writer.token, request, writer.sub), 60);
  if (!limit.ok) return tooManyRequests("Too many requests.", limit);
  return { sub: writer.sub };
}
