import { NextResponse, after } from "next/server";
import { ownSite } from "@/lib/api/site";
import { v1 } from "@/lib/api/v1";
import { MAX_PAGES_PER_JOB } from "@/lib/api/limits";
import { advanceAndNotify } from "@/lib/jobs/run";
import { createJob, jobCounts } from "@/lib/jobs/store";
import { requireScope, ServiceError } from "@/lib/service";
import { listSitePages } from "@/lib/site/theme-preview";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Republishes every page the site has published, as one job (#67). Each page
 * goes out at its current revision; a page whose render key is unchanged is
 * neither rendered nor uploaded, so a second call with no changes does nothing.
 */
export function POST(request: Request) {
  return v1(
    request,
    "v1-site-republish",
    5,
    async (ctx, _request, _note, credential) => {
      const siteId = await ownSite(ctx, "pages:publish");
      requireScope(ctx, "pages:read");
      const pages = (await listSitePages(siteId)).slice(0, MAX_PAGES_PER_JOB + 1);
      if (pages.length === 0) throw new ServiceError("invalid", "This site has no published pages to republish.");
      if (pages.length > MAX_PAGES_PER_JOB) throw new ServiceError("invalid", `A job takes at most ${MAX_PAGES_PER_JOB} pages; republish a smaller set with POST /jobs.`);
      const job = await createJob({
        credentialId: `${credential.kind}:${credential.id}:${ctx.actor.sub}`,
        sub: ctx.actor.sub!,
        scopes: [...(ctx.scopes ?? [])],
        siteFolders: ctx.siteFolders,
        ...(ctx.siteId ? { siteId: ctx.siteId } : {}),
        kind: "publish",
        dryRun: false,
        policy: { republish: true },
        items: pages.map((page) => ({ fileId: page.fileId, params: { public: true, latest: true } })),
      });
      after(() => advanceAndNotify(job.id));
      return NextResponse.json({ job: { id: job.id, kind: job.kind, status: job.status, createdAt: job.createdAt }, counts: await jobCounts(job.id) }, { status: 202 });
    },
    { idempotent: true, audit: "job.started" },
  );
}
