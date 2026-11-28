import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { revokeApiKey } from "@/lib/auth/api-keys";
import { getSessionSub } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Revokes a key. It stops working on its next request. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const sub = await getSessionSub();
  if (!sub) return NextResponse.json({ error: "Sign in with Google to manage API keys." }, { status: 401 });
  const { id } = await context.params;
  const revoked = await revokeApiKey(sub, id);
  await auditRequest(request, { event: "api_key.revoked", outcome: revoked ? "ok" : "denied", status: revoked ? 200 : 404, errorCode: revoked ? null : "not_found", actorKey: id });
  if (!revoked) return NextResponse.json({ error: "Key not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
