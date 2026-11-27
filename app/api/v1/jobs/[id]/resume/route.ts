import { after } from "next/server";
import { v1 } from "@/lib/api/v1";
import { advanceAndNotify } from "@/lib/jobs/run";
import { jobCounts, resumeJob } from "@/lib/jobs/store";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Re-queues items that failed, conflicted or were cancelled; finished items never run again. */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(request, "v1-jobs-resume", 30, async (ctx, _request, _note, credential) => {
    const { id } = await context.params;
    const job = await resumeJob(id, `${credential.kind}:${credential.id}:${ctx.actor.sub}`);
    if (!job) throw new ServiceError("not_found", "Job not found.");
    after(() => advanceAndNotify(job.id));
    return { job: { id: job.id, status: job.status }, counts: await jobCounts(job.id) };
  });
}
