import { query } from "@/lib/db/client";
import { gatingEnabled, type Plan } from "./plans";
import { planForSite } from "./orgs";

/**
 * Numeric plan limits (#195). They apply only on the hosted service
 * (PAGEFIRST_EDITION=hosted); a self-hosted install is unlimited. Previews are
 * never counted, and republishing an already-live page does not take a new slot.
 */
export const LIMIT_KEYS = ["livePages", "publishesPerDay"] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

/** `null` means unlimited (enterprise limits are set per contract). */
const LIMITS: Record<Plan, Record<LimitKey, number | null>> = {
  free: { livePages: 10, publishesPerDay: 20 },
  pro: { livePages: 250, publishesPerDay: 500 },
  team: { livePages: 2000, publishesPerDay: 2500 },
  enterprise: { livePages: null, publishesPerDay: null },
};

const ENV_NAMES: Record<LimitKey, string> = { livePages: "LIVE_PAGES", publishesPerDay: "PUBLISHES_PER_DAY" };

/** The limit for a plan; `PAGEFIRST_LIMIT_<PLAN>_<KEY>` overrides it (a number, or "unlimited"). */
export function limitFor(plan: Plan, key: LimitKey): number | null {
  const raw = process.env[`PAGEFIRST_LIMIT_${plan.toUpperCase()}_${ENV_NAMES[key]}`]?.trim().toLowerCase();
  if (raw === "unlimited") return null;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  return LIMITS[plan][key];
}

export type PublishUsage = { plan: Plan; livePages: number; publishesToday: number; limits: { livePages: number | null; publishesPerDay: number | null } };

/** What an organization's site has used, for the editor's meter and for enforcement. */
export async function publishUsage(siteId: string): Promise<PublishUsage> {
  const plan = await planForSite(siteId);
  const [pages, runs] = await Promise.all([
    query<{ n: string }>(
      "SELECT count(*) AS n FROM site_pages WHERE site_id IN (SELECT id FROM sites WHERE org_id = (SELECT org_id FROM sites WHERE id = $1))",
      [siteId],
    ),
    query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_events
        WHERE event = 'page.publish' AND outcome = 'ok' AND error_code = 'public'
          AND at > now() - interval '24 hours'
          AND site_id IN (SELECT id FROM sites WHERE org_id = (SELECT org_id FROM sites WHERE id = $1))`,
      [siteId],
    ),
  ]);
  return {
    plan,
    livePages: Number(pages[0]?.n ?? 0),
    publishesToday: Number(runs[0]?.n ?? 0),
    limits: { livePages: limitFor(plan, "livePages"), publishesPerDay: limitFor(plan, "publishesPerDay") },
  };
}

export class PublishLimitError extends Error {
  readonly status = 402;
  readonly code = "plan_limit";
  constructor(readonly limit: LimitKey, readonly max: number, readonly plan: Plan) {
    super(
      limit === "livePages"
        ? `Your ${plan} plan includes ${max} published pages. Unpublish a page or upgrade to publish more.`
        : `Your ${plan} plan includes ${max} publishes per day. Try again later or upgrade for a higher limit.`,
    );
    this.name = "PublishLimitError";
  }
}

/**
 * Throws PublishLimitError when publishing `fileId` to the site would pass a
 * limit. A page that is already live never counts as a new page.
 */
export async function checkPublishLimits(siteId: string, fileId: string): Promise<void> {
  if (!gatingEnabled()) return;
  const usage = await publishUsage(siteId);
  const { livePages, publishesPerDay } = usage.limits;
  if (publishesPerDay !== null && usage.publishesToday >= publishesPerDay) throw new PublishLimitError("publishesPerDay", publishesPerDay, usage.plan);
  if (livePages !== null && usage.livePages >= livePages) {
    const already = await query("SELECT 1 FROM site_pages WHERE site_id = $1 AND file_id = $2", [siteId, fileId]);
    if (!already[0]) throw new PublishLimitError("livePages", livePages, usage.plan);
  }
}
