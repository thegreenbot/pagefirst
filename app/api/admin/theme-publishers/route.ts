import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { requireSystemAdmin } from "@/lib/admin/system";
import { auditRequest } from "@/lib/audit-request";
import { invitePublisher, listPublishers, PublisherError } from "@/lib/theme/publishers";

export const dynamic = "force-dynamic";

/** Outside theme publishers (#68): system administrators only. */
export async function GET(request: Request) {
  const admin = await requireSystemAdmin(request, "admin.theme-publishers");
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ publishers: await listPublishers() });
}

export async function POST(request: Request) {
  const admin = await requireSystemAdmin(request, "admin.theme-publishers");
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (typeof body.slug !== "string" || typeof body.repository !== "string") {
    return NextResponse.json({ error: "Send slug and repository." }, { status: 400 });
  }
  try {
    const publisher = await invitePublisher(body.slug, body.repository, admin.sub);
    await auditRequest(request, { event: "admin.theme_publisher", outcome: "ok", pagePath: `invite:@${publisher.slug}:${publisher.repository}`, actorSub: admin.sub });
    return NextResponse.json({ publisher }, { status: 201 });
  } catch (cause) {
    if (!(cause instanceof PublisherError)) throw cause;
    return NextResponse.json({ error: cause.message }, { status: 409 });
  }
}
