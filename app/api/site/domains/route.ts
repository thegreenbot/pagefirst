import { NextResponse } from "next/server";
import { domainErrorResponse, requireDomainActor } from "@/lib/domains/request";
import { addSiteDomain, listSiteDomains } from "@/lib/domains/service";
import { readJsonBody } from "@/lib/site/request";

export const dynamic = "force-dynamic";

/** The site's custom domains (#188). */
export async function GET(request: Request) {
  const found = await requireDomainActor(request, "viewer");
  if (!found.ok) return found.response;
  try {
    return NextResponse.json({ domains: await listSiteDomains(found.actor) });
  } catch (error) {
    return domainErrorResponse(error);
  }
}

/** Adds a domain. The answer says which DNS records the owner still has to create. */
export async function POST(request: Request) {
  const found = await requireDomainActor(request, "admin");
  if (!found.ok) return found.response;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const hostname = typeof read.body === "object" && read.body !== null ? (read.body as { hostname?: unknown }).hostname : undefined;
  if (typeof hostname !== "string" || hostname.length === 0 || hostname.length > 300) {
    return NextResponse.json({ error: "Enter the domain to add.", code: "invalid" }, { status: 400 });
  }
  try {
    const view = await addSiteDomain(found.actor, hostname);
    return NextResponse.json(view, { status: 201 });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
