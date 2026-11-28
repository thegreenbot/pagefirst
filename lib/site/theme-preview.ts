import { overrideConflicts, type OverrideConflict } from "@/lib/theme/diff";
import { createHash, randomBytes } from "node:crypto";
import { query, transaction } from "@/lib/db/client";
import { renderPageHtml } from "@/lib/page/render";
import type { Page } from "@/lib/page/types";
import { savePreview, savePreviewAssets } from "@/lib/publish/preview";
import { budgetsFor, checkBudgets, measure, type Breach, type Measurement } from "@/lib/theme/budgets";
import { nodeOptimizer } from "@/lib/theme/csp";
import { orgIdForSite } from "@/lib/tenant/orgs";
import { assertInstallable, checkThemeUpdate, readSitePolicy } from "./theme-policy";
import { lockedPackage, readPresentation, readSiteTheme, resolveUpdate, saveSiteTheme, type SiteThemeConfig } from "./theme-config";
import { visualDiff, visualDiffConfigured } from "./visual-diff";

/**
 * Theme change previews (#66). Any theme change (an upgrade, a new theme,
 * tokens, settings, overrides) can run as a dry run first: a sample of the
 * site's published pages is rendered with the live config and with the
 * candidate, and the report says which pages changed, whether any breaks a
 * byte budget, and, when screenshots are configured, how much of each page
 * looks different. Nothing is saved to the site until the change is applied,
 * and applying refuses if the site's theme moved on since the preview.
 */

export const SAMPLE_SIZE = 5;

/** A page the site has published, kept so a theme change knows what to preview and republish. */
export type SitePage = { fileId: string; path: string };

export type PageReport = {
  fileId: string;
  path: string;
  /** The candidate render, served like any preview. */
  previewPath: string | null;
  /** True when the candidate's HTML differs from the live render. */
  changed: boolean;
  live: Measurement | null;
  candidate: Measurement | null;
  /** Budgets the candidate breaks. */
  breaches: Breach[];
  /** Share of pixels that differ between screenshots of the two renders, 0 to 1, when screenshots are configured. */
  pixelDiff: number | null;
  /** Why the page could not be previewed, for example a template the new theme lacks. */
  error: string | null;
};

export type ChangeReport = {
  from: { theme: string; version: string };
  to: { theme: string; version: string };
  /** Pages the site has published, and how many of them were rendered. */
  pages: number;
  sampled: number;
  changed: number;
  overBudget: number;
  failed: number;
  /** "pixels" when screenshots were compared, else "markup" (HTML compared only). */
  diff: "pixels" | "markup";
  results: PageReport[];
  /** Overridden templates whose original changed in the new theme version (#65), with what changed. */
  overrideConflicts?: OverrideConflict[];
};

export type ChangePreview = {
  id: string;
  status: "open" | "applied" | "discarded";
  createdAt: string;
  change: unknown;
  report: ChangeReport;
};

export class PreviewError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Records a page the site published; called after each successful public publish. */
export async function recordSitePage(siteId: string, page: SitePage & { revisionId?: string | null }): Promise<void> {
  await query(
    `INSERT INTO site_pages (site_id, file_id, path, revision_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, file_id) DO UPDATE SET path = EXCLUDED.path, revision_id = EXCLUDED.revision_id, published_at = now()`,
    [siteId, page.fileId, page.path, page.revisionId ?? null],
  );
}

/** The site's published pages, most recently published first. */
export async function listSitePages(siteId: string): Promise<SitePage[]> {
  const rows = await query<{ file_id: string; path: string }>(
    "SELECT file_id, path FROM site_pages WHERE site_id = $1 ORDER BY published_at DESC, file_id",
    [siteId],
  );
  return rows.map((row) => ({ fileId: row.file_id, path: row.path }));
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Same theme, same lock, same values: the config the preview was measured against. */
function sameConfig(a: SiteThemeConfig, b: SiteThemeConfig): boolean {
  const canonical = (config: SiteThemeConfig) =>
    JSON.stringify([
      config.themeName,
      config.versionRange,
      config.lock.integrity,
      Object.entries(config.tokens).sort(),
      Object.entries(config.settings).sort(),
      config.customCss,
      Object.entries(config.templateOverrides).sort(),
      [...config.locks].sort(),
    ]);
  return canonical(a) === canonical(b);
}

export type PreviewOptions = {
  /** Loads a page's current content; the route reads it from Google with the owner's token. */
  loadPage: (fileId: string) => Promise<Page | null>;
  sample?: number;
};

/**
 * Runs a theme change as a dry run and stores the report. Throws ConfigError
 * when the change itself is invalid, exactly as applying it would.
 */
export async function previewChange(siteId: string, change: unknown, options: PreviewOptions): Promise<ChangePreview> {
  const current = await readSiteTheme(siteId);
  const candidate = await resolveUpdate(current, change, await orgIdForSite(siteId));
  checkThemeUpdate(await readSitePolicy(siteId), current, candidate);
  await assertInstallable(current, candidate, change);
  const [liveTheme, candidateTheme] = await Promise.all([lockedPackage(current.lock.integrity), lockedPackage(candidate.lock.integrity)]);
  const budgets = budgetsFor(candidateTheme.manifest);
  const pages = await listSitePages(siteId);
  const sample = pages.slice(0, Math.max(1, Math.min(options.sample ?? SAMPLE_SIZE, 20)));
  const id = `tp_${randomBytes(9).toString("base64url")}`;
  const screenshots = visualDiffConfigured();

  const results: PageReport[] = [];
  for (const [index, entry] of sample.entries()) {
    const report: PageReport = { fileId: entry.fileId, path: entry.path, previewPath: null, changed: false, live: null, candidate: null, breaches: [], pixelDiff: null, error: null };
    results.push(report);
    try {
      const page = await options.loadPage(entry.fileId);
      if (!page) {
        report.error = "The page's Doc could not be read.";
        continue;
      }
      const presentation = await readPresentation(siteId, entry.fileId);
      const live = renderPageHtml(page, "publish", { theme: liveTheme, config: current, presentation });
      const next = renderPageHtml(page, "publish", { theme: candidateTheme, config: candidate, presentation });
      report.live = measure(live, nodeOptimizer.gzipSize);
      report.candidate = measure(next, nodeOptimizer.gzipSize);
      report.breaches = checkBudgets(report.candidate, budgets);
      report.changed = sha(live.html) !== sha(next.html);
      const key = `${id}-${index}`;
      savePreviewAssets(next.assets);
      await savePreview(key, next.html, next.csp, page.revisionId);
      report.previewPath = `/published/${key}`;
      if (screenshots && report.changed) report.pixelDiff = await visualDiff(live.html, next.html).catch(() => null);
      else if (screenshots) report.pixelDiff = 0;
    } catch (error) {
      report.error = error instanceof Error ? error.message : "The page could not be rendered.";
    }
  }

  const report: ChangeReport = {
    from: { theme: current.themeName, version: current.lock.version },
    to: { theme: candidate.themeName, version: candidate.lock.version },
    pages: pages.length,
    sampled: sample.length,
    changed: results.filter((result) => result.changed).length,
    overBudget: results.filter((result) => result.breaches.length > 0).length,
    failed: results.filter((result) => result.error).length,
    diff: screenshots && results.some((result) => result.pixelDiff !== null) ? "pixels" : "markup",
    results,
    overrideConflicts: overrideConflicts(candidate.templateOverrides, liveTheme.templates, candidateTheme.templates),
  };
  const rows = await query<{ created_at: Date }>(
    `INSERT INTO theme_change_previews (id, site_id, change, from_config, to_config, report)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
    [id, siteId, JSON.stringify(change), JSON.stringify(current), JSON.stringify(candidate), JSON.stringify(report)],
  );
  return { id, status: "open", createdAt: rows[0]!.created_at.toISOString(), change, report };
}

type PreviewRow = {
  id: string;
  status: ChangePreview["status"];
  created_at: Date;
  change: unknown;
  from_config: SiteThemeConfig;
  to_config: SiteThemeConfig;
  report: ChangeReport;
};

export async function readChangePreview(siteId: string, id: string): Promise<ChangePreview | null> {
  const rows = await query<PreviewRow>("SELECT * FROM theme_change_previews WHERE id = $1 AND site_id = $2", [id, siteId]);
  const row = rows[0];
  return row ? { id: row.id, status: row.status, createdAt: row.created_at.toISOString(), change: row.change, report: row.report } : null;
}

/**
 * Applies a previewed change: saves the candidate config (and its lock) and
 * returns the site's pages to republish. Nothing goes live until they are
 * republished. Refuses when the preview is not open, or when the site's theme
 * config changed since the preview, so what is applied is what was previewed.
 */
export async function applyChange(siteId: string, id: string): Promise<{ config: SiteThemeConfig; republish: SitePage[] }> {
  const config = await transaction(async (client) => {
    // One theme change at a time per site.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`site-theme:${siteId}`]);
    const found = await client.query<PreviewRow>("SELECT * FROM theme_change_previews WHERE id = $1 AND site_id = $2 FOR UPDATE", [id, siteId]);
    const row = found.rows[0];
    if (!row) throw new PreviewError("Preview not found", 404);
    if (row.status !== "open") throw new PreviewError(`This preview was already ${row.status}.`, 409);
    const current = await readSiteTheme(siteId);
    if (!sameConfig(current, row.from_config)) {
      throw new PreviewError("The site's theme changed since this preview. Preview the change again.", 409);
    }
    await saveSiteTheme(siteId, row.to_config, (sql, params) => client.query(sql, params));
    await client.query("UPDATE theme_change_previews SET status = 'applied', resolved_at = now() WHERE id = $1", [id]);
    return row.to_config;
  });
  return { config, republish: await listSitePages(siteId) };
}

/** Discards an open preview; the site keeps its current theme. */
export async function discardChange(siteId: string, id: string): Promise<void> {
  const rows = await query("UPDATE theme_change_previews SET status = 'discarded', resolved_at = now() WHERE id = $1 AND site_id = $2 AND status = 'open' RETURNING id", [id, siteId]);
  if (rows.length) return;
  const preview = await readChangePreview(siteId, id);
  if (!preview) throw new PreviewError("Preview not found", 404);
  throw new PreviewError(`This preview was already ${preview.status}.`, 409);
}
