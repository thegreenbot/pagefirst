import { NextResponse } from "next/server";
import { domainErrorResponse, requireDomainActor } from "@/lib/domains/request";
import { checkSiteDomain } from "@/lib/domains/service";

export const dynamic = "force-dynamic";

/** Asks where the domain stands, and starts serving it once it is verified. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const found = await requireDomainActor(request, "admin");
  if (!found.ok) return found.response;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Domain not found", code: "not_found" }, { status: 404 });
  try {
    return NextResponse.json(await checkSiteDomain(found.actor, id));
  } catch (error) {
    return domainErrorResponse(error);
  }
}
