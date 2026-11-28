import { auditEventsFor } from "@/lib/audit";
import { v1 } from "@/lib/api/v1";
import { databaseConfigured } from "@/lib/db/client";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** The caller's own audit events, newest first, with a cursor. Never another user's. */
export function GET(request: Request) {
  return v1(request, "v1-audit", 60, async (ctx) => {
    if (!ctx.actor.sub || !databaseConfigured()) throw new ServiceError("unsupported", "Audit history needs a signed-in account and a database.");
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    const cursor = url.searchParams.get("cursor");
    if (cursor !== null && !/^\d{1,18}$/.test(cursor)) throw new ServiceError("invalid", "cursor is not valid.");
    const rows = await auditEventsFor(ctx.actor.sub, limit + 1, cursor ?? undefined);
    const events = rows.slice(0, limit);
    return { events, nextCursor: rows.length > limit ? events[events.length - 1]!.id : null };
  });
}
