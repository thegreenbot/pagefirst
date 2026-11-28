import { databaseConfigured, query } from "@/lib/db/client";
import { FIELD_TARGETS, VITAL_METRICS, type VitalMetric } from "@/lib/theme/beacon";

/**
 * Field speed from real visitors (#70). Off by default per site; when on, the
 * published pages carry a small beacon that posts LCP, CLS and INP to the app.
 * Samples hold a site, a path, a metric and a number, and are kept 30 days.
 */

export const RETENTION_DAYS = 30;
const PATH = /^\/[A-Za-z0-9._~\/-]{0,200}$/;
const MAX_VALUE: Record<VitalMetric, number> = { lcp: 60_000, cls: 10, inp: 10_000 };

export async function speedReportEnabled(siteId: string): Promise<boolean> {
  if (!databaseConfigured()) return false;
  const rows = await query<{ speed_report: boolean }>("SELECT speed_report FROM sites WHERE id = $1", [siteId]);
  return rows[0]?.speed_report === true;
}

export async function setSpeedReport(siteId: string, enabled: boolean): Promise<void> {
  await query("UPDATE sites SET speed_report = $2 WHERE id = $1", [siteId, enabled]);
}

export type Sample = { site: string; path: string; values: Partial<Record<VitalMetric, number>> };

/** Parses a beacon body. Anything unexpected is refused, and unknown keys are ignored. */
export function parseSample(text: string): Sample | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.site !== "string" || !/^[\w-]{1,64}$/.test(record.site)) return null;
  if (typeof record.path !== "string" || !PATH.test(record.path)) return null;
  const values: Sample["values"] = {};
  for (const metric of VITAL_METRICS) {
    const value = record[metric];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_VALUE[metric]) return null;
    values[metric] = metric === "cls" ? Math.round(value * 1000) / 1000 : Math.round(value);
  }
  return Object.keys(values).length > 0 ? { site: record.site, path: record.path, values } : null;
}

/** Stores a sample if the site exists and has the report on; returns whether it did. */
export async function recordSample(sample: Sample): Promise<boolean> {
  if (!(await speedReportEnabled(sample.site))) return false;
  const metrics = Object.keys(sample.values) as VitalMetric[];
  await query(
    `INSERT INTO vitals_samples (site_id, path, metric, value)
     SELECT $1, $2, m, v FROM unnest($3::text[], $4::real[]) AS t(m, v)`,
    [sample.site, sample.path, metrics, metrics.map((metric) => sample.values[metric]!)],
  );
  return true;
}

export type MetricSummary = { p75: number; samples: number; good: boolean };
export type PageSpeed = { path: string; metrics: Partial<Record<VitalMetric, MetricSummary>> };
export type SpeedReport = { enabled: boolean; days: number; targets: typeof FIELD_TARGETS; pages: PageSpeed[] };

/** p75 per page and metric over the last `days`, worst first. */
export async function speedReport(siteId: string, days = 7): Promise<SpeedReport> {
  const window = Math.min(Math.max(Math.floor(days), 1), RETENTION_DAYS);
  const enabled = await speedReportEnabled(siteId);
  // Old samples go when anyone reads the report, so no scheduler is needed.
  await query("DELETE FROM vitals_samples WHERE site_id = $1 AND created_at < now() - ($2 || ' days')::interval", [siteId, String(RETENTION_DAYS)]);
  const rows = await query<{ path: string; metric: VitalMetric; p75: number; samples: string }>(
    `SELECT path, metric, percentile_cont(0.75) WITHIN GROUP (ORDER BY value) AS p75, count(*) AS samples
       FROM vitals_samples
      WHERE site_id = $1 AND created_at > now() - ($2 || ' days')::interval
      GROUP BY path, metric`,
    [siteId, String(window)],
  );
  const byPath = new Map<string, PageSpeed>();
  for (const row of rows) {
    const page = byPath.get(row.path) ?? { path: row.path, metrics: {} };
    page.metrics[row.metric] = { p75: Number(row.p75), samples: Number(row.samples), good: Number(row.p75) <= FIELD_TARGETS[row.metric] };
    byPath.set(row.path, page);
  }
  const failing = (page: PageSpeed) => Object.values(page.metrics).filter((m) => !m.good).length;
  const pages = [...byPath.values()].sort((a, b) => failing(b) - failing(a) || a.path.localeCompare(b.path));
  return { enabled, days: window, targets: FIELD_TARGETS, pages };
}
