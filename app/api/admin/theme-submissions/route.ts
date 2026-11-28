import { NextResponse } from "next/server";
import { requireSystemAdmin } from "@/lib/admin/system";
import { listSubmissions, type SubmissionStatus } from "@/lib/theme/submissions";

export const dynamic = "force-dynamic";

/** The approval queue (#68). `?status=pending|approved|rejected|all`, pending by default. */
export async function GET(request: Request) {
  const admin = await requireSystemAdmin(request, "admin.theme-submissions");
  if (admin instanceof NextResponse) return admin;
  const status = new URL(request.url).searchParams.get("status") ?? "pending";
  if (!["pending", "approved", "rejected", "all"].includes(status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
  return NextResponse.json({ submissions: await listSubmissions(status === "all" ? null : (status as SubmissionStatus)) });
}
