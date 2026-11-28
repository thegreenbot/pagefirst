import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { configuredDomainProvider } from "@/lib/domains";
import { activeDomainCount, reverifyDomains } from "@/lib/domains/service";
import { advanceJob } from "@/lib/jobs/run";
import { unfinishedJobIds } from "@/lib/jobs/store";
import { deliverDue } from "@/lib/jobs/webhook";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Picks up work nobody is polling: jobs left unfinished by a process that died,
 * and webhooks due for a retry (#40). Called by a scheduler with
 * `Authorization: Bearer $CRON_SECRET`; Vercel cron sends that header itself.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ids = await unfinishedJobIds(5);
  for (const id of ids) await advanceJob(id, 10_000).catch(() => undefined);
  const webhooks = await deliverDue(20);
  // Custom domains: finish validating new ones, and stop serving any that no longer validate (#188).
  const domains = configuredDomainProvider() ? await reverifyDomains().catch(() => null) : null;
  const activeDomains = await activeDomainCount().catch(() => null);
  return NextResponse.json({ advanced: ids.length, webhooks, domains, activeDomains });
}
