import { v1 } from "@/lib/api/v1";
import { jobCounts, requestCancel } from "@/lib/jobs/store";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Stops handing out new items. Items already running finish; finished items are kept. */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(request, "v1-jobs-cancel", 30, async (ctx, _request, credential) => {
    const { id } = await context.params;
    const job = await requestCancel(id, `${credential.kind}:${credential.id}:${ctx.actor.sub}`);
    if (!job) throw new ServiceError("not_found", "Job not found.");
    return { job: { id: job.id, status: job.status, cancelRequested: job.cancelRequested }, counts: await jobCounts(job.id) };
  });
}
