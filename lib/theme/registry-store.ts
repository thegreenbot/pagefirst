import { query } from "@/lib/db/client";
import { budgetsFor, checkBudgets, measure, type Breach } from "./budgets";
import { nodeOptimizer, publishedCsp } from "./csp";
import { renderPage } from "./engine";
import { themeFixtures } from "./fixtures";
import type { ThemeManifest } from "./manifest";
import { loadThemeFromFiles, type ThemePackage } from "./package";
import { satisfies } from "./registry";
import { countersign, verifyCountersignature } from "./signing";
import { archiveIntegrity, unpackTheme } from "./tarball";

/**
 * The theme registry (#64): immutable, countersigned theme versions in
 * Postgres. v1 lists first-party themes only; versions arrive from the
 * trusted-publishing CI job (scripts/theme-publish.ts).
 */

/** Who published a version and how, kept with it: the CI identity and its Sigstore bundle. */
export type Provenance = Record<string, unknown>;

export type ThemeVersion = {
  name: string;
  version: string;
  integrity: string;
  description: string;
  publishedAt: string;
  yanked: boolean;
  advisory: string | null;
  budgets: Record<string, unknown>;
  scores: Record<string, unknown> | null;
};

export class RegistryError extends Error {}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Byte budgets on every fixture page; Lighthouse scores come from the publishing CI run. */
function checkPackage(theme: ThemePackage): { measured: Record<string, unknown>; breaches: Breach[] } {
  const budgets = budgetsFor(theme.manifest);
  const measured: Record<string, unknown> = {};
  const breaches: Breach[] = [];
  for (const fixture of themeFixtures(theme.manifest)) {
    const result = renderPage(fixture.page, theme, { mode: "publish", csp: publishedCsp, optimizer: nodeOptimizer });
    const m = measure(result, nodeOptimizer.gzipSize);
    measured[fixture.name] = m;
    breaches.push(...checkBudgets(m, budgets).map((breach) => ({ ...breach, label: `${fixture.name}: ${breach.label}` })));
  }
  return { measured, breaches };
}

/**
 * Checks, countersigns and stores a version. The archive must load as a valid
 * theme, meet its byte budgets, and be a version the registry has not seen.
 */
export async function publishVersion(archive: Uint8Array, provenance: Provenance, scores: Record<string, unknown> | null = null): Promise<ThemeVersion> {
  let theme: ThemePackage;
  try {
    theme = loadThemeFromFiles(unpackTheme(archive));
  } catch (error) {
    throw new RegistryError(`The archive is not a valid theme: ${(error as Error).message}`);
  }
  const { name, version } = theme.manifest;
  if (!VERSION.test(version)) throw new RegistryError(`${version} is not a valid version`);
  const { measured, breaches } = checkPackage(theme);
  if (breaches.length) {
    throw new RegistryError(`${name}@${version} is over budget: ${breaches.map((b) => `${b.label} ${b.actual} > ${b.limit} ${b.unit}`).join("; ")}`);
  }
  const integrity = archiveIntegrity(archive);
  const signature = countersign(name, version, integrity);
  const rows = await query<{ published_at: Date }>(
    `INSERT INTO theme_versions (name, version, integrity, archive, manifest, budgets, scores, provenance, countersignature)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT DO NOTHING
     RETURNING published_at`,
    [name, version, integrity, Buffer.from(archive), JSON.stringify(theme.manifest), JSON.stringify(measured), scores ? JSON.stringify(scores) : null, JSON.stringify(provenance), signature],
  );
  if (!rows[0]) throw new RegistryError(`${name}@${version} is already published; versions are immutable`);
  return {
    name,
    version,
    integrity,
    description: theme.manifest.description ?? "",
    publishedAt: rows[0].published_at.toISOString(),
    yanked: false,
    advisory: null,
    budgets: measured,
    scores,
  };
}

type VersionRow = {
  name: string;
  version: string;
  integrity: string;
  manifest: ThemeManifest;
  budgets: Record<string, unknown>;
  scores: Record<string, unknown> | null;
  published_at: Date;
  yanked_at: Date | null;
  advisory: string | null;
};

const fromRow = (row: VersionRow): ThemeVersion => ({
  name: row.name,
  version: row.version,
  integrity: row.integrity,
  description: row.manifest.description ?? "",
  publishedAt: row.published_at.toISOString(),
  yanked: row.yanked_at !== null,
  advisory: row.advisory,
  budgets: row.budgets,
  scores: row.scores,
});

const COLUMNS = "name, version, integrity, manifest, budgets, scores, published_at, yanked_at, advisory";

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  // A release sorts above its prereleases.
  return Number(!a.includes("-")) - Number(!b.includes("-"));
}

export async function listVersions(name: string): Promise<ThemeVersion[]> {
  const rows = await query<VersionRow>(`SELECT ${COLUMNS} FROM theme_versions WHERE name = $1`, [name]);
  return rows.map(fromRow).sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest installable version of each theme. */
export async function listThemes(): Promise<ThemeVersion[]> {
  const rows = await query<VersionRow>(`SELECT ${COLUMNS} FROM theme_versions WHERE yanked_at IS NULL`);
  const latest = new Map<string, ThemeVersion>();
  for (const version of rows.map(fromRow)) {
    const current = latest.get(version.name);
    if (!current || compareVersions(version.version, current.version) > 0) latest.set(version.name, version);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The newest version in range that is not yanked: what a new lock resolves to. */
export async function resolveVersion(name: string, range: string): Promise<ThemeVersion | null> {
  return (await listVersions(name)).find((version) => !version.yanked && satisfies(version.version, range)) ?? null;
}

/** The newest version that is not yanked. */
export async function latestVersion(name: string): Promise<ThemeVersion | null> {
  return (await listVersions(name)).find((version) => !version.yanked) ?? null;
}

/** Yanking stops new installs; sites already locked to the version keep rendering it. */
export async function yankVersion(name: string, version: string, advisory: string | null = null): Promise<void> {
  const rows = await query("UPDATE theme_versions SET yanked_at = COALESCE(yanked_at, now()), advisory = COALESCE($3, advisory) WHERE name = $1 AND version = $2 RETURNING name", [name, version, advisory]);
  if (!rows.length) throw new RegistryError(`${name}@${version} is not published`);
}

const verified = new Map<string, ThemePackage>();

/**
 * The package a lock points at, verified: the archive's bytes must hash to
 * the locked integrity, the registry's countersignature must match, and the
 * manifest inside must name the same theme and version. Only verified
 * packages are kept in memory.
 */
export async function loadVerifiedVersion(integrity: string): Promise<ThemePackage> {
  const cached = verified.get(integrity);
  if (cached) return cached;
  const rows = await query<{ name: string; version: string; integrity: string; archive: Buffer; countersignature: string }>(
    "SELECT name, version, integrity, archive, countersignature FROM theme_versions WHERE integrity = $1",
    [integrity],
  );
  const row = rows[0];
  if (!row) throw new RegistryError(`Theme version ${integrity} is not in the registry`);
  const archive = new Uint8Array(row.archive);
  if (archiveIntegrity(archive) !== integrity) throw new RegistryError(`${row.name}@${row.version}: archive does not match its integrity; refusing to render`);
  if (!verifyCountersignature(row.name, row.version, integrity, row.countersignature)) {
    throw new RegistryError(`${row.name}@${row.version}: registry signature is missing or invalid; refusing to render`);
  }
  const theme = loadThemeFromFiles(unpackTheme(archive));
  if (theme.manifest.name !== row.name || theme.manifest.version !== row.version) {
    throw new RegistryError(`${row.name}@${row.version}: archive holds ${theme.manifest.name}@${theme.manifest.version}; refusing to render`);
  }
  verified.set(integrity, theme);
  return theme;
}

/** For tests: forget verified packages so the next load checks the stored bytes again. */
export function clearVerifiedCache(): void {
  verified.clear();
}
