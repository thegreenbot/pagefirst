import { NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/admin/system";
import { domainErrorResponse } from "@/lib/domains/request";
import { disableHostname } from "@/lib/domains/service";
import { readJsonBody } from "@/lib/site/request";

export const dynamic = "force-dynamic";

/** Abuse takedown (#190): blocks a hostname and stops serving it at once. */
export async function POST(request: Request) {
  const admin = await requireSystemAdmin(request, "admin.domains");
  if (admin instanceof NextResponse) return admin;
  const read = await readJsonBody(request);
  if (!read.ok) return read.response;
  const body = typeof read.body === "object" && read.body !== null ? (read.body as { hostname?: unknown; reason?: unknown }) : {};
  if (typeof body.hostname !== "string" || typeof body.reason !== "string" || !body.reason.trim()) {
    return NextResponse.json({ error: "A hostname and a reason are required." }, { status: 400 });
  }
  try {
    return NextResponse.json({ disabled: await disableHostname(body.hostname, body.reason) });
  } catch (error) {
    return domainErrorResponse(error);
  }
}
