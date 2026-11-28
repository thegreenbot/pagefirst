import { NextResponse, after } from "next/server";
import { v1, readJson } from "@/lib/api/v1";
import { MAX_PAGES_PER_JOB } from "@/lib/api/limits";
import { advanceAndNotify } from "@/lib/jobs/run";
import { createJob, JOB_KINDS, jobCounts, type JobKind, type NewItem } from "@/lib/jobs/store";
import { encryptionConfigured } from "@/lib/crypto/secretbox";
import { UnsafeUrlError, validateWebhookUrl } from "@/lib/net/public-host";
import { isSafeId } from "@/lib/page/types";
import { requireScope, ServiceError, type ServiceContext } from "@/lib/service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopesFor(ctx: ServiceContext, kind: JobKind, items: NewItem[]): void {
  if (kind === "commit") requireScope(ctx, "pages:commit");
  else if (kind === "publish") requireScope(ctx, items.some((item) => item.params.public === true) ? "pages:publish" : "pages:read");
  else {
    requireScope(ctx, "pages:import");
    if (kind === "import_and_publish") requireScope(ctx, "pages:publish");
  }
}

/**
 * Starts a bulk job: `{ kind, items: [{ fileId, ... }], dryRun, policy }`. It
 * runs in the background as the credential's owner; poll `GET /jobs/{id}`.
 */
export function POST(request: Request) {
  return v1(
    request,
    "v1-jobs-create",
    10,
    async (ctx, _request, note, credential) => {
      if (!ctx.actor.sub) throw new ServiceError("unsupported", "Jobs need a signed-in account.");
      const body = await readJson(request, 2 * 1024 * 1024);
      if (!isRecord(body)) throw new ServiceError("invalid", "The body must be a JSON object.");
      const kind = body.kind;
      if (typeof kind !== "string" || !(JOB_KINDS as readonly string[]).includes(kind)) {
        throw new ServiceError("invalid", `kind must be one of ${JOB_KINDS.join(", ")}.`);
      }
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > MAX_PAGES_PER_JOB) {
        throw new ServiceError("invalid", `items must have 1 to ${MAX_PAGES_PER_JOB} entries.`);
      }
      const items: NewItem[] = body.items.map((entry, i) => {
        if (!isRecord(entry) || typeof entry.fileId !== "string" || !isSafeId(entry.fileId)) {
          throw new ServiceError("invalid", `items[${i}].fileId is not a valid page id.`);
        }
        const { fileId, ...params } = entry;
        return { fileId, params };
      });
      if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new ServiceError("invalid", "dryRun must be true or false.");
      if (body.policy !== undefined && !isRecord(body.policy)) throw new ServiceError("invalid", "policy must be an object.");
      scopesFor(ctx, kind as JobKind, items);
      let webhook: { url: string; secret: string } | undefined;
      if (body.webhook !== undefined) {
        if (!isRecord(body.webhook) || typeof body.webhook.secret !== "string" || body.webhook.secret.length < 16 || body.webhook.secret.length > 256) {
          throw new ServiceError("invalid", "webhook must be { url, secret } with a secret of 16 to 256 characters.");
        }
        try {
          webhook = { url: validateWebhookUrl(body.webhook.url).toString(), secret: body.webhook.secret };
        } catch (error) {
          if (error instanceof UnsafeUrlError) throw new ServiceError("invalid", `webhook.${error.message}`);
          throw error;
        }
        if (!encryptionConfigured()) throw new ServiceError("unsupported", "Webhooks are not available on this instance.");
      }

      const job = await createJob({
        credentialId: `${credential.kind}:${credential.id}:${ctx.actor.sub}`,
        sub: ctx.actor.sub,
        scopes: [...(ctx.scopes ?? [])],
        siteFolders: ctx.siteFolders,
        ...(ctx.siteId ? { siteId: ctx.siteId } : {}),
        kind: kind as JobKind,
        dryRun: body.dryRun === true,
        policy: (body.policy as Record<string, unknown> | undefined) ?? {},
        items,
        ...(webhook ? { webhook } : {}),
      });
      after(() => advanceAndNotify(job.id));
      return NextResponse.json({ job: { id: job.id, kind: job.kind, status: job.status, dryRun: job.dryRun, createdAt: job.createdAt }, counts: await jobCounts(job.id) }, { status: 202 });
    },
    { idempotent: true, audit: "job.started" },
  );
}
