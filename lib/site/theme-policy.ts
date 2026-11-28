import { query } from "@/lib/db/client";
import { orgIdForSite } from "@/lib/tenant/orgs";
import { bundledTheme } from "@/lib/theme/registry";
import { tierOfIntegrity } from "@/lib/theme/registry-store";
import { ConfigError, type SiteThemeConfig } from "./theme-config";

/**
 * An organization's theme policy (#69). The table and these checks are core
 * (Apache-2.0); the admin routes that edit a policy live in enterprise/ and are
 * gated by plan on the hosted service. A site with no policy row is unrestricted.
 */

export type ThemePolicy = {
  /** Tokens every site of the organization renders with, whatever the site stores. */
  lockedTokens: Record<string, string | number>;
  /** Theme names a site may switch to; null allows any. */
  allowedThemes: string[] | null;
  /** Only registry versions (countersigned by the registry) and bundled first-party themes. */
  requireSigned: boolean;
  /** A publish that renders over a performance budget is refused instead of warned about. */
  blockOnBudget: boolean;
};

export const NO_POLICY: ThemePolicy = { lockedTokens: {}, allowedThemes: null, requireSigned: false, blockOnBudget: false };

type Row = { locked_tokens: Record<string, string | number>; allowed_themes: string[] | null; require_signed: boolean; block_on_budget: boolean };

const fromRow = (row: Row): ThemePolicy => ({ lockedTokens: row.locked_tokens, allowedThemes: row.allowed_themes, requireSigned: row.require_signed, blockOnBudget: row.block_on_budget });

export async function readOrgPolicy(orgId: string): Promise<ThemePolicy> {
  const rows = await query<Row>("SELECT * FROM org_theme_policy WHERE org_id = $1", [orgId]);
  return rows[0] ? fromRow(rows[0]) : NO_POLICY;
}

export async function readSitePolicy(siteId: string): Promise<ThemePolicy> {
  const orgId = await orgIdForSite(siteId);
  return orgId ? readOrgPolicy(orgId) : NO_POLICY;
}

export async function saveOrgPolicy(orgId: string, policy: ThemePolicy, updatedBy: string | null): Promise<void> {
  await query(
    `INSERT INTO org_theme_policy (org_id, locked_tokens, allowed_themes, require_signed, block_on_budget, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id) DO UPDATE SET locked_tokens = EXCLUDED.locked_tokens, allowed_themes = EXCLUDED.allowed_themes,
       require_signed = EXCLUDED.require_signed, block_on_budget = EXCLUDED.block_on_budget, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, JSON.stringify(policy.lockedTokens), policy.allowedThemes ? JSON.stringify(policy.allowedThemes) : null, policy.requireSigned, policy.blockOnBudget, updatedBy],
  );
}

const TOKEN_KEY = /^[a-z][a-z0-9-]{0,63}$/;
const TOKEN_VALUE = /^[^;{}<>\\\u0000-\u001f]*$/;
const THEME_NAME = /^@[a-z0-9-]{1,39}\/[a-z0-9-]{1,64}$/;

/** Validates a policy from a request body; throws ConfigError naming the bad field. */
export function parsePolicy(input: unknown): ThemePolicy {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new ConfigError("policy", "must be an object");
  const raw = input as Record<string, unknown>;
  const lockedTokens: ThemePolicy["lockedTokens"] = {};
  if (raw.lockedTokens !== undefined) {
    if (typeof raw.lockedTokens !== "object" || raw.lockedTokens === null || Array.isArray(raw.lockedTokens)) throw new ConfigError("lockedTokens", "must be an object of token values");
    const entries = Object.entries(raw.lockedTokens);
    if (entries.length > 50) throw new ConfigError("lockedTokens", "can lock at most 50 tokens");
    for (const [key, value] of entries) {
      if (!TOKEN_KEY.test(key)) throw new ConfigError(`lockedTokens.${key}`, "is not a token name");
      if (typeof value === "number" ? !Number.isFinite(value) : typeof value !== "string" || value.length > 200 || !TOKEN_VALUE.test(value)) {
        throw new ConfigError(`lockedTokens.${key}`, "must be a number or a plain string");
      }
      lockedTokens[key] = value as string | number;
    }
  }
  let allowedThemes: string[] | null = null;
  if (raw.allowedThemes !== undefined && raw.allowedThemes !== null) {
    if (!Array.isArray(raw.allowedThemes) || raw.allowedThemes.length > 50 || raw.allowedThemes.some((name) => typeof name !== "string" || !THEME_NAME.test(name))) {
      throw new ConfigError("allowedThemes", "must be a list of up to 50 theme names like @scope/name, or null for any theme");
    }
    allowedThemes = [...new Set(raw.allowedThemes as string[])];
  }
  for (const flag of ["requireSigned", "blockOnBudget"] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== "boolean") throw new ConfigError(flag, "must be true or false");
  }
  return { lockedTokens, allowedThemes, requireSigned: raw.requireSigned === true, blockOnBudget: raw.blockOnBudget === true };
}

/** Registry versions carry the registry's countersignature (sha512-); bundled first-party themes are signed by being shipped with the app. */
function isSignedTheme(config: Pick<SiteThemeConfig, "themeName" | "lock">): boolean {
  return config.lock.integrity.startsWith("sha512-") || bundledTheme(config.themeName) !== null;
}

/**
 * Throws a ConfigError when moving a site from `current` to `next` breaks the
 * policy. Sites already on a disallowed theme keep rendering; they can't move
 * to another disallowed one, and they can't change a locked token.
 */
export function checkThemeUpdate(policy: ThemePolicy, current: SiteThemeConfig, next: SiteThemeConfig): void {
  const themeMoved = next.themeName !== current.themeName || next.lock.integrity !== current.lock.integrity;
  if (themeMoved) {
    if (policy.allowedThemes && !policy.allowedThemes.includes(next.themeName)) {
      throw new ConfigError("themeName", "is not on your organization's list of allowed themes");
    }
    if (policy.requireSigned && !isSignedTheme(next)) {
      throw new ConfigError("themeName", "must be a signed theme version under your organization's policy");
    }
  }
  for (const [key, locked] of Object.entries(policy.lockedTokens)) {
    const value = next.tokens[key];
    if (value !== undefined && String(value) !== String(locked) && String(value) !== String(current.tokens[key])) {
      throw new ConfigError(`tokens.${key}`, "is locked by your organization");
    }
  }
}

/** The config a site renders with: locked tokens win over whatever the site stored. */
export function withLockedTokens(config: SiteThemeConfig, policy: ThemePolicy): SiteThemeConfig {
  return Object.keys(policy.lockedTokens).length === 0 ? config : { ...config, tokens: { ...config.tokens, ...policy.lockedTokens } };
}

/** Render warnings that mean a performance budget was exceeded (see lib/theme/engine.ts). */
export function budgetWarnings(warnings: readonly string[]): string[] {
  return warnings.filter((warning) => /budget/i.test(warning));
}

/**
 * A community theme version has passed automated checks only, so moving a site
 * onto one needs an explicit `acceptUnreviewed: true` in the change (#68).
 * First-party, verified and private versions, and bundled themes, need nothing.
 */
export async function assertInstallable(current: SiteThemeConfig, next: SiteThemeConfig, input: unknown): Promise<void> {
  if (next.themeName === current.themeName && next.lock.integrity === current.lock.integrity) return;
  if ((await tierOfIntegrity(next.lock.integrity)) !== "community") return;
  const accepted = typeof input === "object" && input !== null && (input as { acceptUnreviewed?: unknown }).acceptUnreviewed === true;
  if (!accepted) throw new ConfigError("acceptUnreviewed", `${next.themeName} is an unreviewed community theme: it passed automated checks only. Send acceptUnreviewed: true to install it.`);
}
