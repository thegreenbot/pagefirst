import { NextResponse } from "next/server";
import { databaseConfigured, query } from "@/lib/db/client";
import { callerKey, checkRateLimit, requireGoogleWriter, tooManyRequests } from "@/lib/guard";
import { readTextCapped } from "@/lib/http/body";
import { requireOrgFeature, roleOf, type Role } from "@/lib/tenant/orgs";
import { PlanError, type Feature } from "@/lib/tenant/plans";

export type Admin = { sub: string; orgId: string; role: Role };

/**
 * The signed-in owner or admin of an organization, for the cookie-authenticated
 * enterprise admin routes. Strangers and non-admins get the same 404 so the
 * route does not reveal which organizations exist.
 */
export async function requireOrgAdmin(request: Request, orgId: string, feature: Feature | null, action: string, minimum: "admin" | "owner" = "admin"): Promise<Admin | NextResponse> {
  const writer = await requireGoogleWriter();
  if (!writer.ok || !writer.sub) return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
  if (!databaseConfigured()) return NextResponse.json({ error: "This needs the database." }, { status: 503 });
  const limit = await checkRateLimit(action, callerKey(writer.token, request, writer.sub), 20);
  if (!limit.ok) return tooManyRequests("Too many requests.", limit);
  const role = await roleOf(orgId, writer.sub);
  const allowed = role === "owner" || (minimum === "admin" && role === "admin");
  if (!role || !allowed) return NextResponse.json({ error: "Organization not found." }, { status: 404 });
  if (feature) {
    const blocked = await planBlock(orgId, feature);
    if (blocked) return blocked;
  }
  return { sub: writer.sub, orgId, role };
}

/** A 402 response when the organization's plan lacks the feature, else null. */
export async function planBlock(orgId: string, feature: Feature): Promise<NextResponse | null> {
  try {
    await requireOrgFeature(orgId, feature);
    return null;
  } catch (error) {
    if (error instanceof PlanError) return NextResponse.json({ error: error.message }, { status: 402 });
    throw error;
  }
}

export async function readJsonBody(request: Request, maxBytes = 4_000): Promise<Record<string, unknown> | NextResponse> {
  const read = await readTextCapped(request, maxBytes);
  if (!read.ok) return NextResponse.json({ error: "Request is too large." }, { status: 413 });
  try {
    const body = read.text ? JSON.parse(read.text) : {};
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
}

/** The Workspace domain recorded for an account at its last sign-in. */
export async function accountDomain(sub: string): Promise<string | null> {
  const rows = await query<{ hd: string | null }>("SELECT hd FROM users WHERE sub = $1", [sub]);
  return rows[0]?.hd ?? null;
}
