import { after } from "next/server";
import { v1 } from "@/lib/api/v1";
import { advanceJob } from "@/lib/jobs/run";
import { getJob, jobCounts, listItems } from "@/lib/jobs/store";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** A job's status, counts and per-item results. Polling it also moves an unfinished job forward. */
export function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(request, "v1-jobs-get", 120, async (ctx, _request, credential) => {
    const { id } = await context.params;
    const job = await getJob(id, `${credential.kind}:${credential.id}:${ctx.actor.sub}`);
    if (!job) throw new ServiceError("not_found", "Job not found.");
    if (job.status === "queued" || job.status === "running") after(() => advanceJob(job.id).catch(() => undefined));
    const url = new URL(request.url);
    const afterIdx = /^\d{1,6}$/.test(url.searchParams.get("after") ?? "") ? Number(url.searchParams.get("after")) : -1;
    const limit = Number(url.searchParams.get("limit")) || 100;
    const items = await listItems(job.id, afterIdx, limit);
    return {
      job: { id: job.id, kind: job.kind, status: job.status, dryRun: job.dryRun, cancelRequested: job.cancelRequested, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
      counts: await jobCounts(job.id),
      items: items.map((item) => ({ idx: item.idx, fileId: item.fileId, status: item.status, code: item.code, message: item.message, result: item.result })),
      nextAfter: items.length === Math.min(Math.max(limit, 1), 500) ? items[items.length - 1]!.idx : null,
    };
  });
}
