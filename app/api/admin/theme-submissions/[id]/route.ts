import { NextResponse } from "next/server";
import { readJsonObject } from "@/lib/http/body";
import { requireSystemAdmin } from "@/lib/admin/system";
import { auditRequest } from "@/lib/audit-request";
import { RegistryError } from "@/lib/theme/registry-store";
import { approveSubmission, getSubmission, rejectSubmission, ReviewError } from "@/lib/theme/submissions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requireSystemAdmin(request, "admin.theme-submissions");
  if (admin instanceof NextResponse) return admin;
  const { id } = await context.params;
  const submission = UUID.test(id) ? await getSubmission(id) : null;
  if (!submission) return NextResponse.json({ error: "No such submission." }, { status: 404 });
  return NextResponse.json({ submission });
}

/** Approve or reject: `{ "decision": "approve" }` or `{ "decision": "reject", "reason": "…" }`. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const admin = await requireSystemAdmin(request, "admin.theme-submissions");
  if (admin instanceof NextResponse) return admin;
  const { id } = await context.params;
  const submission = UUID.test(id) ? await getSubmission(id) : null;
  if (!submission) return NextResponse.json({ error: "No such submission." }, { status: 404 });
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  const subject = `${submission.name}@${submission.version}`;
  try {
    if (body.decision === "approve") {
      const published = await approveSubmission(id, admin.sub);
      await auditRequest(request, { event: "admin.theme_review", outcome: "ok", pagePath: `approve:${subject}`, actorSub: admin.sub });
      return NextResponse.json({ published: { name: published.name, version: published.version, integrity: published.integrity, tier: published.tier } });
    }
    if (body.decision === "reject") {
      await rejectSubmission(id, admin.sub, typeof body.reason === "string" ? body.reason : "");
      await auditRequest(request, { event: "admin.theme_review", outcome: "ok", pagePath: `reject:${subject}`, actorSub: admin.sub });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'decision must be "approve" or "reject".' }, { status: 400 });
  } catch (cause) {
    if (cause instanceof ReviewError || cause instanceof RegistryError) return NextResponse.json({ error: cause.message }, { status: 409 });
    throw cause;
  }
}
