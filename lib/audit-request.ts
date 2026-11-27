import { headers } from "next/headers";
import { clientIp, recordAudit, requestIdFrom, type AuditEvent } from "@/lib/audit";
import { getSessionSub } from "@/lib/session";

type Partial = Omit<AuditEvent, "requestId" | "ip" | "actorSub"> & { actorSub?: string | null };

/** Records an event for a route handler's request, filling in the request id, caller and hashed IP. */
export async function auditRequest(request: Request, event: Partial): Promise<void> {
  const actorSub = event.actorSub !== undefined ? event.actorSub : await getSessionSub().catch(() => null);
  await recordAudit({ ...event, actorSub, requestId: requestIdFrom(request), ip: clientIp(request) });
}

/** The same, for a server action, which has headers but no Request. */
export async function auditAction(event: Partial): Promise<void> {
  const list = await headers();
  await auditRequest(new Request("http://action.local/", { headers: list }), event);
}
