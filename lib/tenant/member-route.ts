import { NextResponse } from "next/server";
import { syncSeats } from "@/lib/billing/billing";
import { MemberError } from "./members";

/** A MemberError as its JSON response; anything else is not ours to swallow. */
export function memberErrorResponse(error: unknown): NextResponse {
  if (error instanceof MemberError) return NextResponse.json({ error: error.message }, { status: error.status });
  throw error;
}

/** Seats follow membership. A billing outage must not undo a membership change, so it is logged, not thrown. */
export async function seatsChanged(orgId: string): Promise<void> {
  await syncSeats(orgId).catch((error: unknown) => console.error("seat sync failed", orgId, error instanceof Error ? error.name : "unknown"));
}
