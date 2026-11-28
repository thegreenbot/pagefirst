import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import { describeFindings, checkTheme } from "./checks";
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

export const TRUST_TIERS = ["first-party", "verified", "community", "private"] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

export type ThemeVersion = {
  name: string;
  /** Who vouches for it (#68). Installing a community version needs an explicit confirmation. */
  tier: TrustTier;
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
export async function publishVersion(
  archive: Uint8Array,
  provenance: Provenance,
  scores: Record<string, unknown> | null = null,
  /** Called with the loaded manifest before anything is signed or stored; throws to refuse the publisher. */
  authorize?: (manifest: ThemeManifest) => void,
  /** The organization that owns a private version (#69); null publishes to the public registry. */
  ownerOrg: string | null = null,
  /** A private version is always `private`; a public one defaults to first-party, the only publishers v1 admits. */
  tier: TrustTier = ownerOrg ? "private" : "first-party",
): Promise<ThemeVersion> {
  let theme: ThemePackage;
  try {
    theme = loadThemeFromFiles(unpackTheme(archive));
  } catch (error) {
    throw new RegistryError(`The archive is not a valid theme: ${(error as Error).message}`);
  }
  const { name, version } = theme.manifest;
  authorize?.(theme.manifest);
  if (!VERSION.test(version)) throw new RegistryError(`${version} is not a valid version`);
  // Static checks for code and loads the manifest doesn't declare, for every publisher (#68).
  const findings = checkTheme(theme);
  if (findings.length) throw new RegistryError(`${name}@${version} failed the submission checks: ${describeFindings(findings)}`);
  const { measured, breaches } = checkPackage(theme);
  if (breaches.length) {
    throw new RegistryError(`${name}@${version} is over budget: ${breaches.map((b) => `${b.label} ${b.actual} > ${b.limit} ${b.unit}`).join("; ")}`);
  }
  const integrity = archiveIntegrity(archive);
  const signature = countersign(name, version, integrity);
  // A name belongs to whoever published it first: a public name is never claimed privately, and the reverse.
  const owners = await query<{ owner_org: string | null }>("SELECT DISTINCT owner_org FROM theme_versions WHERE name = $1", [name]);
  if (owners.some((row) => row.owner_org !== ownerOrg)) throw new RegistryError(`${name} belongs to another publisher`);
  const rows = await query<{ published_at: Date }>(
    `INSERT INTO theme_versions (name, version, integrity, archive, manifest, budgets, scores, provenance, countersignature, owner_org, trust_tier)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT DO NOTHING
     RETURNING published_at`,
    [name, version, integrity, Buffer.from(archive), JSON.stringify(theme.manifest), JSON.stringify(measured), scores ? JSON.stringify(scores) : null, JSON.stringify(provenance), signature, ownerOrg, tier],
  );
  if (!rows[0]) throw new RegistryError(`${name}@${version} is already published; versions are immutable`);
  return {
    name,
    tier,
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
  trust_tier: TrustTier;
};

const fromRow = (row: VersionRow): ThemeVersion => ({
  name: row.name,
  tier: row.trust_tier,
  version: row.version,
  integrity: row.integrity,
  description: row.manifest.description ?? "",
  publishedAt: row.published_at.toISOString(),
  yanked: row.yanked_at !== null,
  advisory: row.advisory,
  budgets: row.budgets,
  scores: row.scores,
});

const COLUMNS = "name, version, integrity, manifest, budgets, scores, published_at, yanked_at, advisory, trust_tier";

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  // A release sorts above its prereleases.
  return Number(!a.includes("-")) - Number(!b.includes("-"));
}

/** Public versions, plus the private ones `orgId` owns (#69). */
const VISIBLE = "(owner_org IS NULL OR owner_org = $1)";

export async function listVersions(name: string, orgId: string | null = null): Promise<ThemeVersion[]> {
  const rows = await query<VersionRow>(`SELECT ${COLUMNS} FROM theme_versions WHERE name = $2 AND ${VISIBLE}`, [orgId, name]);
  return rows.map(fromRow).sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest installable version of each theme. */
export async function listThemes(orgId: string | null = null): Promise<ThemeVersion[]> {
  const rows = await query<VersionRow>(`SELECT ${COLUMNS} FROM theme_versions WHERE yanked_at IS NULL AND ${VISIBLE}`, [orgId]);
  const latest = new Map<string, ThemeVersion>();
  for (const version of rows.map(fromRow)) {
    const current = latest.get(version.name);
    if (!current || compareVersions(version.version, current.version) > 0) latest.set(version.name, version);
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The newest version in range that is not yanked: what a new lock resolves to. */
export async function resolveVersion(name: string, range: string, orgId: string | null = null): Promise<ThemeVersion | null> {
  return (await listVersions(name, orgId)).find((version) => !version.yanked && satisfies(version.version, range)) ?? null;
}

/** The newest version that is not yanked. */
export async function latestVersion(name: string, orgId: string | null = null): Promise<ThemeVersion | null> {
  return (await listVersions(name, orgId)).find((version) => !version.yanked) ?? null;
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

/** The name scope an organization's private themes live under: `@org-<12 hex>/name`. */
export function privateScope(orgId: string): string {
  return `org-${createHash("sha256").update(orgId).digest("hex").slice(0, 12)}`;
}

/** Private versions an organization owns, newest first, yanked ones included. */
export async function listOrgVersions(orgId: string): Promise<ThemeVersion[]> {
  const rows = await query<VersionRow>(`SELECT ${COLUMNS} FROM theme_versions WHERE owner_org = $1`, [orgId]);
  return rows.map(fromRow).sort((a, b) => a.name.localeCompare(b.name) || compareVersions(b.version, a.version));
}

/** The tier of the version a lock points at; null for bundled themes and snapshots, which are first-party. */
export async function tierOfIntegrity(integrity: string): Promise<TrustTier | null> {
  const rows = await query<{ trust_tier: TrustTier }>("SELECT trust_tier FROM theme_versions WHERE integrity = $1", [integrity]);
  return rows[0]?.trust_tier ?? null;
}

/**
 * Moves a version between tiers after review (#68). Verified needs a person's
 * review, so nothing here decides that: the caller is the reviewer's tooling.
 * A private version never leaves `private`, and a public one never becomes it.
 */
export async function setTier(name: string, version: string, tier: TrustTier): Promise<void> {
  const rows = await query<{ owner_org: string | null }>("SELECT owner_org FROM theme_versions WHERE name = $1 AND version = $2", [name, version]);
  if (!rows[0]) throw new RegistryError(`${name}@${version} is not published`);
  if ((rows[0].owner_org !== null) !== (tier === "private")) throw new RegistryError("A private version stays private, and a public one can't become private.");
  await query("UPDATE theme_versions SET trust_tier = $3 WHERE name = $1 AND version = $2", [name, version, tier]);
}
