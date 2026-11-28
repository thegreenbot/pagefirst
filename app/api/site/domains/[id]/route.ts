import { NextResponse } from "next/server";
import { domainErrorResponse, requireDomainActor } from "@/lib/domains/request";
import { removeSiteDomain } from "@/lib/domains/service";

export const dynamic = "force-dynamic";

/** Stops serving the domain and releases it. */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const found = await requireDomainActor(request, "admin");
  if (!found.ok) return found.response;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Domain not found", code: "not_found" }, { status: 404 });
  try {
    await removeSiteDomain(found.actor, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
