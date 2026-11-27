import { NextResponse } from "next/server";
import { v1 } from "@/lib/api/v1";
import { buildReport, reportCsv } from "@/lib/jobs/report";
import { getJob, jobCounts, listItems } from "@/lib/jobs/store";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Every page's outcome, as JSON or `?format=csv`, for audit teams. */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(request, "v1-jobs-report", 30, async (ctx, _request, credential) => {
    const { id } = await context.params;
    const job = await getJob(id, `${credential.kind}:${credential.id}:${ctx.actor.sub}`);
    if (!job) throw new ServiceError("not_found", "Job not found.");
    const report = buildReport(job, await jobCounts(job.id), await listItems(job.id, -1, 500));
    if (new URL(request.url).searchParams.get("format") === "csv") {
      return new NextResponse(reportCsv(report), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${job.id}.csv"` } });
    }
    return report;
  });
}
