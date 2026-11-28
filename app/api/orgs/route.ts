import { NextResponse } from "next/server";
import { databaseConfigured } from "@/lib/db/client";
import { requireGoogleWriter } from "@/lib/guard";
import { listMemberships } from "@/lib/tenant/orgs";

export const dynamic = "force-dynamic";

/**
 * The signed-in user's organizations, roles and sites, for the org switcher.
 * A client then sends X-Pagefirst-Site to act on one of those sites.
 */
export async function GET() {
  const writer = await requireGoogleWriter();
  if (!writer.ok) return NextResponse.json({ error: writer.error }, { status: 401 });
  if (!writer.sub || !databaseConfigured()) return NextResponse.json({ organizations: [] });
  return NextResponse.json({ organizations: await listMemberships(writer.sub) });
}
