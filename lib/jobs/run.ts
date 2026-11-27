import { accessTokenFor } from "@/lib/auth/server-sessions";
import { applyOps } from "@/lib/page/ops";
import { isSafeId } from "@/lib/page/types";
import { validateCommitRequest } from "@/lib/page/validate";
import { commit, getPage, publish, ServiceError, type ServiceContext } from "@/lib/service";
import { deliverDue } from "./webhook";
import { claimItems, finishItem, readJobById, releaseItem, settleJob, type ItemStatus, type JobItem, type JobRow } from "./store";

/**
 * Runs a job's items as the credential's owner, within the owner's Google
 * quota: a few items at a time, each through the same service functions as
 * the interactive API. A finished item is never run again; a transient quota
 * error puts the item back for a later pass instead of failing it (#40).
 */

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 3;

type Outcome = { status: Exclude<ItemStatus, "pending" | "running">; code?: string; message?: string; result?: unknown } | { retry: true };

function contextFor(job: JobRow, item: JobItem, googleToken: string): ServiceContext {
  return {
    actor: { sub: job.sub, client: "api" },
    googleToken,
    requestId: `${job.id}:${item.idx}`,
    scopes: new Set(job.scopes),
    ...(job.siteFolders ? { siteFolders: job.siteFolders } : {}),
    ...(job.siteId ? { siteId: job.siteId } : {}),
  };
}

function fromError(error: unknown, item: JobItem): Outcome {
  if (error instanceof ServiceError) {
    if ((error.code === "upstream_quota" || error.code === "rate_limited") && item.attempts < MAX_ATTEMPTS) return { retry: true };
    const status = error.code === "conflict" ? "conflict" : "error";
    return { status, code: error.code === "conflict" ? "revision_conflict" : error.code, message: error.message };
  }
  return { status: "error", code: "upstream_error", message: "The item could not be processed." };
}

export async function runItem(job: JobRow, item: JobItem, googleToken: string): Promise<Outcome> {
  const ctx = contextFor(job, item, googleToken);
  if (!isSafeId(item.fileId)) return { status: "error", code: "invalid", message: "Invalid page id." };
  try {
    if (job.kind === "import" || job.kind === "import_and_publish") {
      return { status: "skipped", code: "unsupported", message: "Importing Doc changes is not available yet." };
    }
    if (job.kind === "commit") {
      const parsed = validateCommitRequest({ baseRevisionId: item.params.baseRevisionId, ops: item.params.ops });
      if (!parsed.ok) return { status: "error", code: "invalid", message: `${parsed.path}: ${parsed.error}` };
      if (job.dryRun) {
        const payload = await getPage(ctx, item.fileId);
        if (!payload) return { status: "error", code: "not_found", message: "Page not found." };
        if (payload.page.revisionId !== parsed.value.baseRevisionId) {
          return { status: "conflict", code: "revision_conflict", message: "The page changed since that revision.", result: { revisionId: payload.page.revisionId } };
        }
        applyOps(payload.page, parsed.value.ops);
        return { status: "ok", result: { dryRun: true, revisionId: payload.page.revisionId } };
      }
      const result = await commit(ctx, item.fileId, parsed.value.baseRevisionId, parsed.value.ops);
      if (!result.ok) {
        if ((result.code === "upstream_quota" || result.status === 429) && item.attempts < MAX_ATTEMPTS) return { retry: true };
        return result.status === 409
          ? { status: "conflict", code: "revision_conflict", message: result.error, result: result.page ? { revisionId: result.page.revisionId } : undefined }
          : { status: "error", code: result.code ?? "upstream_error", message: result.error };
      }
      return { status: "ok", result: { revisionId: result.page.revisionId } };
    }
    // publish
    // `latest` publishes whatever the page is now (a site-wide republish); otherwise the revision is pinned.
    const latest = item.params.latest === true;
    const revisionId = typeof item.params.revisionId === "string" ? item.params.revisionId : undefined;
    if (!revisionId && !latest) return { status: "error", code: "invalid", message: "revisionId is required: publish a pinned revision." };
    if (job.dryRun) {
      const payload = await getPage(ctx, item.fileId);
      if (!payload) return { status: "error", code: "not_found", message: "Page not found." };
      if (revisionId && payload.page.revisionId !== revisionId) {
        return { status: "conflict", code: "revision_conflict", message: "The page changed since that revision.", result: { revisionId: payload.page.revisionId } };
      }
      return { status: "ok", result: { dryRun: true, revisionId: payload.page.revisionId } };
    }
    const { response, audit } = await publish(ctx, item.fileId, { ...(revisionId ? { revisionId } : {}), public: item.params.public === true });
    return { status: "ok", result: { revisionId: audit.resultRevisionId, previewPath: response.previewPath, url: response.url, ...(response.unchanged ? { unchanged: true } : {}) } };
  } catch (error) {
    return fromError(error, item);
  }
}

/**
 * Works on a job for up to `budgetMs`, then returns so a serverless function
 * can end. Call it again (poll, cron, a restarted process) to continue.
 */
export async function advanceJob(jobId: string, budgetMs = 20_000): Promise<{ done: boolean }> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const job = await readJobById(jobId);
    if (!job || job.status === "done" || job.status === "cancelled") return { done: true };
    if (job.cancelRequested) return { done: (await settleJob(jobId)) !== null };
    if (Date.now() >= deadline) return { done: false };
    const items = await claimItems(jobId, CONCURRENCY);
    if (items.length === 0) {
      const settled = await settleJob(jobId);
      // Items still running elsewhere: nothing for this pass to take.
      return { done: settled !== null };
    }
    const googleToken = await accessTokenFor(job.sub);
    let paused = false;
    await Promise.all(
      items.map(async (item) => {
        const outcome = googleToken
          ? await runItem(job, item, googleToken)
          : ({ status: "error", code: "unauthenticated", message: "The owner needs to sign in to Pagefirst again to reconnect Google." } as const);
        if ("retry" in outcome) {
          await releaseItem(jobId, item.idx);
          paused = true;
          return;
        }
        const { status, ...detail } = outcome;
        await finishItem(jobId, item.idx, status, detail);
      }),
    );
    // A quota hit means stop for now; the next pass resumes after the pacing window.
    if (paused) return { done: false };
  }
}

/** Advances a job, then sends any completion webhooks that are due (this job's, or an earlier one's retry). */
export async function advanceAndNotify(jobId: string): Promise<void> {
  await advanceJob(jobId).catch(() => undefined);
  await deliverDue(3).catch(() => undefined);
}
