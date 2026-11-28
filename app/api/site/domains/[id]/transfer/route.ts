import { NextResponse } from "next/server";
import { domainErrorResponse, requireDomainActor } from "@/lib/domains/request";
import { transferSiteDomain } from "@/lib/domains/service";
import { readJsonBody } from "@/lib/site/request";

export const dynamic = "force-dynamic";

/** Moves a domain to another site of the same owner. It stops serving until the new site is verified. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const found = await requireDomainActor(request, "admin");
  if (!found.ok) return found.response;
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "Domain not found", code: "not_found" }, { status: 404 });
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const siteId = typeof read.body === "object" && read.body !== null ? (read.body as { siteId?: unknown }).siteId : undefined;
  if (typeof siteId !== "string" || !/^[\w-]{1,64}$/.test(siteId)) return NextResponse.json({ error: "Choose the site to move it to.", code: "invalid" }, { status: 400 });
  try {
    return NextResponse.json(await transferSiteDomain(found.actor, id, siteId));
  } catch (error) {
    return domainErrorResponse(error);
  }
}
