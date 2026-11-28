import { randomBytes } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { orgIdForSite } from "@/lib/tenant/orgs";
import { ConfigError, readSiteTheme, resolveUpdate, saveSiteTheme } from "./theme-config";
import { assertInstallable, checkThemeUpdate, readOrgPolicy } from "./theme-policy";
import { listSitePages } from "./theme-preview";

/**
 * Staged rollout of one theme change across an organization's sites (#69). The
 * admin names the change and the stages (lists of site ids, canary first). Each
 * advance applies the next stage's sites under the same checks as a single-site
 * update (validation, the organization's policy, one change at a time per site),
 * and halts, leaving later stages untouched, when any site in the stage fails.
 * It saves each site's config only: pages go live when they are republished
 * (`POST /api/v1/site/republish`), which each result lists the pages for.
 */

export type RolloutStatus = "open" | "halted" | "complete" | "cancelled";
export type SiteResult = { stage: number; status: "applied" | "failed"; error?: string; pagesToRepublish?: number };
export type Rollout = {
  id: string;
  orgId: string;
  change: unknown;
  stages: string[][];
  nextStage: number;
  status: RolloutStatus;
  results: Record<string, SiteResult>;
  createdAt: string;
};

const LIMITS = { stages: 20, sites: 500 };

type Row = { id: string; org_id: string; change: unknown; stages: string[][]; next_stage: number; status: RolloutStatus; results: Record<string, SiteResult>; created_at: Date };
const fromRow = (row: Row): Rollout => ({ id: row.id, orgId: row.org_id, change: row.change, stages: row.stages, nextStage: row.next_stage, status: row.status, results: row.results, createdAt: row.created_at.toISOString() });

export class RolloutError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function orgSiteIds(orgId: string): Promise<Set<string>> {
  const rows = await query<{ id: string }>("SELECT id FROM sites WHERE org_id = $1", [orgId]);
  return new Set(rows.map((row) => row.id));
}

/** Checks the stages name each of the organization's sites at most once, 1 to 20 stages of at least one site. */
export function parseStages(input: unknown, allowed: ReadonlySet<string>): string[][] {
  if (!Array.isArray(input) || input.length < 1 || input.length > LIMITS.stages) throw new RolloutError(`stages must be 1 to ${LIMITS.stages} lists of site ids`, 400);
  const seen = new Set<string>();
  const stages: string[][] = [];
  for (const stage of input) {
    if (!Array.isArray(stage) || stage.length < 1 || stage.some((id) => typeof id !== "string")) throw new RolloutError("every stage must be a non-empty list of site ids", 400);
    for (const id of stage as string[]) {
      if (!allowed.has(id)) throw new RolloutError(`${id} is not a site of this organization`, 400);
      if (seen.has(id)) throw new RolloutError(`${id} appears in more than one stage`, 400);
      seen.add(id);
    }
    stages.push([...(stage as string[])]);
  }
  if (seen.size > LIMITS.sites) throw new RolloutError(`a rollout covers at most ${LIMITS.sites} sites`, 400);
  return stages;
}

/** What each site would do with the change right now, without saving anything: the same checks an advance runs. */
export async function checkChange(orgId: string, change: unknown, siteIds: string[]): Promise<Record<string, string | null>> {
  const policy = await readOrgPolicy(orgId);
  const out: Record<string, string | null> = {};
  for (const siteId of siteIds) {
    try {
      const current = await readSiteTheme(siteId);
      const next = await resolveUpdate(current, change, orgId);
      checkThemeUpdate(policy, current, next);
      await assertInstallable(current, next, change);
      out[siteId] = null;
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      out[siteId] = error.message;
    }
  }
  return out;
}

export async function createRollout(orgId: string, change: unknown, stagesInput: unknown, createdBy: string | null): Promise<{ rollout: Rollout; problems: Record<string, string> }> {
  const stages = parseStages(stagesInput, await orgSiteIds(orgId));
  if (typeof change !== "object" || change === null || Array.isArray(change)) throw new RolloutError("change must be an object like a theme update", 400);
  // Refuse a rollout nothing could apply to: a bad theme name fails here, once, not at every site.
  const checked = await checkChange(orgId, change, stages.flat());
  const problems = Object.fromEntries(Object.entries(checked).filter((entry): entry is [string, string] => entry[1] !== null));
  if (Object.keys(problems).length === stages.flat().length) throw new RolloutError(`The change can't be applied to any of these sites: ${Object.values(problems)[0]}`, 400);
  const id = `ro_${randomBytes(9).toString("base64url")}`;
  const rows = await query<Row>(
    "INSERT INTO org_theme_rollouts (id, org_id, change, stages, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [id, orgId, JSON.stringify(change), JSON.stringify(stages), createdBy],
  );
  return { rollout: fromRow(rows[0]!), problems };
}

export async function readRollout(orgId: string, id: string): Promise<Rollout | null> {
  const rows = await query<Row>("SELECT * FROM org_theme_rollouts WHERE id = $1 AND org_id = $2", [id, orgId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function listRollouts(orgId: string, limit = 20): Promise<Rollout[]> {
  const rows = await query<Row>("SELECT * FROM org_theme_rollouts WHERE org_id = $1 ORDER BY created_at DESC LIMIT $2", [orgId, limit]);
  return rows.map(fromRow);
}

/** Applies the change to one site under the per-site lock; throws ConfigError when the site refuses it. */
async function applyToSite(orgId: string, siteId: string, change: unknown): Promise<number> {
  const policy = await readOrgPolicy(orgId);
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`site-theme:${siteId}`]);
    const current = await readSiteTheme(siteId);
    const next = await resolveUpdate(current, change, orgId);
    checkThemeUpdate(policy, current, next);
    await assertInstallable(current, next, change);
    await saveSiteTheme(siteId, next, (sql, params) => client.query(sql, params));
  });
  return (await listSitePages(siteId)).length;
}

/**
 * Applies the next stage. A site that already applied is skipped, so advancing
 * a halted rollout retries only the sites that failed. Any failure halts the
 * rollout at this stage; all-success moves on, and the last stage completes it.
 */
export async function advanceRollout(orgId: string, id: string): Promise<Rollout> {
  const rollout = await readRollout(orgId, id);
  if (!rollout) throw new RolloutError("Rollout not found", 404);
  if (rollout.status === "complete" || rollout.status === "cancelled") throw new RolloutError(`This rollout is already ${rollout.status}.`, 409);
  const stage = rollout.nextStage;
  const results = { ...rollout.results };
  let failed = 0;
  for (const siteId of rollout.stages[stage]!) {
    if (results[siteId]?.status === "applied") continue;
    // Sites that left the organization since the rollout began are failures, not silent skips.
    if ((await orgIdForSite(siteId)) !== orgId) {
      results[siteId] = { stage, status: "failed", error: "The site is no longer in this organization." };
      failed++;
      continue;
    }
    try {
      results[siteId] = { stage, status: "applied", pagesToRepublish: await applyToSite(orgId, siteId, rollout.change) };
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      results[siteId] = { stage, status: "failed", error: error.message };
      failed++;
    }
  }
  const nextStage = failed ? stage : stage + 1;
  const status: RolloutStatus = failed ? "halted" : nextStage >= rollout.stages.length ? "complete" : "open";
  const rows = await query<Row>(
    "UPDATE org_theme_rollouts SET results = $3, next_stage = $4, status = $5, updated_at = now() WHERE id = $1 AND org_id = $2 RETURNING *",
    [id, orgId, JSON.stringify(results), nextStage, status],
  );
  return fromRow(rows[0]!);
}

/** Stops a rollout: sites already changed keep the change, later stages never run. */
export async function cancelRollout(orgId: string, id: string): Promise<Rollout> {
  const rows = await query<Row>(
    "UPDATE org_theme_rollouts SET status = 'cancelled', updated_at = now() WHERE id = $1 AND org_id = $2 AND status IN ('open', 'halted') RETURNING *",
    [id, orgId],
  );
  if (rows[0]) return fromRow(rows[0]);
  if (!(await readRollout(orgId, id))) throw new RolloutError("Rollout not found", 404);
  throw new RolloutError("This rollout is already finished.", 409);
}
