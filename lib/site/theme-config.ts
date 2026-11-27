import { randomBytes } from "node:crypto";
import { databaseConfigured, query, transaction } from "@/lib/db/client";
import { ensurePersonalOrg, requireFeature, siteAllows } from "@/lib/tenant/orgs";
import type { ThemeManifest } from "@/lib/theme/manifest";
import type { ThemePackage } from "@/lib/theme/package";
import { orphanTokens, tokenDefs } from "@/lib/theme/tokens";
import { bundledTheme, bundledThemes, DEFAULT_THEME_NAME, isVersionRange, packageIntegrity, satisfies } from "@/lib/theme/registry";
import { latestVersion, listThemes, loadVerifiedVersion, resolveVersion } from "@/lib/theme/registry-store";

/**
 * Each site's theme config and each page's presentation, stored by the app
 * (#56). The Google Doc holds content only.
 */

export type SiteThemeConfig = {
  themeName: string;
  versionRange: string;
  tokens: Record<string, string | number>;
  settings: Record<string, string | number | boolean>;
  customCss: string;
  templateOverrides: Record<string, string>;
  locks: string[];
  /** The lockfile: the exact version and package bytes later publishes render with. */
  lock: { version: string; integrity: string };
};

export type PagePresentation = {
  template: string;
  /** Section id to style names. */
  sectionStyles: Record<string, string[]>;
};

export type ConfigUpdate = Partial<Omit<SiteThemeConfig, "lock">>;

export class ConfigError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
  }
}

const LIMITS = {
  tokens: 100,
  tokenValue: 200,
  customCss: 50_000,
  overrides: 50,
  overrideBytes: 64_000,
  locks: 20,
  sectionStyles: 200,
};

const IDENTIFIER = /^[a-z][a-z0-9-]{0,39}$/;
const THEME_NAME = /^@[a-z0-9-]{1,39}\/[a-z0-9-]{1,64}$/;
const TOKEN_KEY = /^[a-z][a-z0-9-]{0,63}$/;
/** Token values become CSS custom properties (#57): no characters that end a declaration or a block. */
const TOKEN_VALUE = /^[^;{}<>\\\u0000-\u001f]*$/;
const OVERRIDE_PATH = /^(layouts\/[a-z][a-z0-9-]{0,39}|partials\/[a-z][a-z0-9-]{0,39}|blocks\/[a-z][a-z0-9-]{0,39}\/block)$/;
const LOCKABLE = new Set(["theme", "tokens", "settings", "custom-css", "templates"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks an update against the theme it will apply to. Throws ConfigError. */
export function validateUpdate(input: unknown, manifest: ThemeManifest, theme?: Pick<ThemePackage, "tokens">): ConfigUpdate {
  if (!isRecord(input)) throw new ConfigError("body", "must be an object");
  const out: ConfigUpdate = {};
  for (const key of Object.keys(input)) {
    if (!["themeName", "versionRange", "tokens", "settings", "customCss", "templateOverrides", "locks"].includes(key)) {
      throw new ConfigError(key, "is not a theme config field");
    }
  }
  if (input.themeName !== undefined) {
    // Availability is checked when the update locks to a version (registry or bundled).
    if (typeof input.themeName !== "string" || !THEME_NAME.test(input.themeName)) {
      throw new ConfigError("themeName", "is not an available theme");
    }
    out.themeName = input.themeName;
  }
  if (input.versionRange !== undefined) {
    if (!isVersionRange(input.versionRange)) throw new ConfigError("versionRange", "must be x.y.z, ^x.y.z or ~x.y.z");
    out.versionRange = input.versionRange;
  }
  if (input.tokens !== undefined) {
    if (!isRecord(input.tokens)) throw new ConfigError("tokens", "must be an object");
    const entries = Object.entries(input.tokens);
    if (entries.length > LIMITS.tokens) throw new ConfigError("tokens", `at most ${LIMITS.tokens}`);
    out.tokens = {};
    for (const [key, value] of entries) {
      if (!TOKEN_KEY.test(key)) throw new ConfigError(`tokens.${key}`, "is not a valid token name");
      if (theme && !Object.hasOwn(tokenDefs(theme), key)) throw new ConfigError(`tokens.${key}`, `is not a token of ${manifest.name}`);
      if (typeof value === "number" && Number.isFinite(value)) out.tokens[key] = value;
      else if (typeof value === "string" && value.length <= LIMITS.tokenValue && TOKEN_VALUE.test(value)) out.tokens[key] = value;
      else throw new ConfigError(`tokens.${key}`, "must be a number or a short CSS value");
    }
  }
  if (input.settings !== undefined) {
    if (!isRecord(input.settings)) throw new ConfigError("settings", "must be an object");
    const schema = new Map((manifest.settings ?? []).map((setting) => [setting.id, setting]));
    out.settings = {};
    for (const [key, value] of Object.entries(input.settings)) {
      const setting = schema.get(key);
      if (!setting) throw new ConfigError(`settings.${key}`, `is not a setting of ${manifest.name}`);
      const ok =
        setting.type === "boolean"
          ? typeof value === "boolean"
          : setting.type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : setting.type === "select"
              ? typeof value === "string" && (setting.options ?? []).includes(value)
              : setting.type === "color"
                ? typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value)
                : typeof value === "string" && value.length <= 2_000;
      if (!ok) throw new ConfigError(`settings.${key}`, `must be a valid ${setting.type}`);
      out.settings[key] = value as string | number | boolean;
    }
  }
  if (input.customCss !== undefined) {
    if (typeof input.customCss !== "string" || input.customCss.length > LIMITS.customCss) {
      throw new ConfigError("customCss", `must be text of at most ${LIMITS.customCss} characters`);
    }
    if (input.customCss.includes("<")) throw new ConfigError("customCss", "cannot contain '<', so it cannot close the style element");
    if (/@import/i.test(input.customCss)) throw new ConfigError("customCss", "cannot use @import; inline the rules instead");
    out.customCss = input.customCss;
  }
  if (input.templateOverrides !== undefined) {
    if (!isRecord(input.templateOverrides)) throw new ConfigError("templateOverrides", "must be an object");
    const entries = Object.entries(input.templateOverrides);
    if (entries.length > LIMITS.overrides) throw new ConfigError("templateOverrides", `at most ${LIMITS.overrides}`);
    out.templateOverrides = {};
    for (const [path, source] of entries) {
      if (!OVERRIDE_PATH.test(path)) throw new ConfigError(`templateOverrides.${path}`, "is not a template path");
      if (typeof source !== "string" || source.length > LIMITS.overrideBytes) {
        throw new ConfigError(`templateOverrides.${path}`, "must be Liquid source of at most 64 KB");
      }
      out.templateOverrides[path] = source;
    }
  }
  if (input.locks !== undefined) {
    if (!Array.isArray(input.locks) || input.locks.length > LIMITS.locks) throw new ConfigError("locks", "must be a short list");
    for (const lock of input.locks) {
      if (typeof lock !== "string" || !LOCKABLE.has(lock)) throw new ConfigError("locks", `"${String(lock)}" cannot be locked`);
    }
    out.locks = [...new Set(input.locks as string[])];
  }
  return out;
}

export function validatePresentation(input: unknown, manifest: ThemeManifest): PagePresentation {
  if (!isRecord(input)) throw new ConfigError("body", "must be an object");
  const template = input.template ?? "page";
  if (typeof template !== "string" || !Object.hasOwn(manifest.templates, template)) {
    throw new ConfigError("template", `is not a template of ${manifest.name}`);
  }
  const styles = input.sectionStyles ?? {};
  if (!isRecord(styles)) throw new ConfigError("sectionStyles", "must be an object");
  const entries = Object.entries(styles);
  if (entries.length > LIMITS.sectionStyles) throw new ConfigError("sectionStyles", "has too many sections");
  const allowed = new Set(manifest.sectionStyles ?? []);
  const sectionStyles: Record<string, string[]> = {};
  for (const [sectionId, list] of entries) {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(sectionId)) throw new ConfigError(`sectionStyles.${sectionId}`, "is not a section id");
    if (!Array.isArray(list) || !list.every((style) => typeof style === "string" && IDENTIFIER.test(style) && allowed.has(style))) {
      throw new ConfigError(`sectionStyles.${sectionId}`, `must list section styles of ${manifest.name}`);
    }
    if (list.length) sectionStyles[sectionId] = [...new Set(list as string[])];
  }
  return { template, sectionStyles };
}

function newSiteId(): string {
  return `site_${randomBytes(9).toString("base64url")}`;
}

/** The owner's site, created on first use. One site per owner until multi-site lands. */
export async function siteForOwner(sub: string): Promise<string> {
  const existing = await query<{ id: string }>("SELECT id FROM sites WHERE owner_sub = $1 ORDER BY created_at, id LIMIT 1", [sub]);
  if (existing[0]) return existing[0].id;
  return transaction(async (client) => {
    // Serialise first-site creation per owner so two tabs do not make two sites.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`site:${sub}`]);
    const again = await client.query<{ id: string }>("SELECT id FROM sites WHERE owner_sub = $1 ORDER BY created_at, id LIMIT 1", [sub]);
    if (again.rows[0]) return again.rows[0].id;
    const id = newSiteId();
    await client.query("INSERT INTO users (sub) VALUES ($1) ON CONFLICT (sub) DO NOTHING", [sub]);
    const orgId = await ensurePersonalOrg(client, sub);
    await client.query("INSERT INTO sites (id, owner_sub, org_id) VALUES ($1, $2, $3)", [id, sub, orgId]);
    return id;
  });
}

const packageCache = new Map<string, ThemePackage>();

/** Stores a package snapshot by its integrity hash and returns the hash. */
async function snapshot(theme: ThemePackage): Promise<string> {
  const integrity = packageIntegrity(theme);
  await query(
    `INSERT INTO theme_packages (integrity, name, version, package) VALUES ($1, $2, $3, $4)
     ON CONFLICT (integrity) DO NOTHING`,
    [integrity, theme.manifest.name, theme.manifest.version, JSON.stringify(theme)],
  );
  packageCache.set(integrity, theme);
  return integrity;
}

/**
 * The exact package a lock points at. Registry versions (sha512-) are verified
 * against their integrity and the registry's countersignature on every load
 * from storage (#64); bundled snapshots (sha256-) come from the snapshot table.
 */
export async function lockedPackage(integrity: string): Promise<ThemePackage> {
  if (integrity.startsWith("sha512-")) return loadVerifiedVersion(integrity);
  const cached = packageCache.get(integrity);
  if (cached) return cached;
  const rows = await query<{ package: ThemePackage }>("SELECT package FROM theme_packages WHERE integrity = $1", [integrity]);
  if (!rows[0]) throw new Error(`Theme package ${integrity} is missing`);
  packageCache.set(integrity, rows[0].package);
  return rows[0].package;
}

type ConfigRow = {
  theme_name: string;
  version_range: string;
  tokens: Record<string, string | number>;
  settings: Record<string, string | number | boolean>;
  custom_css: string;
  template_overrides: Record<string, string>;
  locks: string[];
  locked_version: string;
  locked_integrity: string;
};

function fromRow(row: ConfigRow): SiteThemeConfig {
  return {
    themeName: row.theme_name,
    versionRange: row.version_range,
    tokens: row.tokens,
    settings: row.settings,
    customCss: row.custom_css,
    templateOverrides: row.template_overrides,
    locks: row.locks,
    lock: { version: row.locked_version, integrity: row.locked_integrity },
  };
}

/**
 * Locks to the newest registry version of the theme in range (#64). A theme
 * the registry does not list yet falls back to the copy bundled with the app.
 */
async function lockTo(themeName: string, versionRange: string): Promise<{ version: string; integrity: string }> {
  const published = await resolveVersion(themeName, versionRange);
  if (published) return { version: published.version, integrity: published.integrity };
  const theme = bundledTheme(themeName);
  if (!theme) throw new ConfigError("themeName", "is not an available theme");
  if (!satisfies(theme.manifest.version, versionRange)) {
    throw new ConfigError("versionRange", `${themeName} ${theme.manifest.version} does not satisfy ${versionRange}`);
  }
  return { version: theme.manifest.version, integrity: await snapshot(theme) };
}

/** Locks to the newest version of a theme, from the registry or else the bundled copy. */
async function lockToLatest(themeName: string): Promise<{ version: string; integrity: string }> {
  const published = await latestVersion(themeName);
  if (published) return { version: published.version, integrity: published.integrity };
  const theme = bundledTheme(themeName);
  if (!theme) throw new ConfigError("themeName", "is not an available theme");
  return lockTo(themeName, theme.manifest.version);
}

/** The site's config; the first read stores the default theme, locked to its current version. */
export async function readSiteTheme(siteId: string): Promise<SiteThemeConfig> {
  const rows = await query<ConfigRow>("SELECT * FROM site_themes WHERE site_id = $1", [siteId]);
  if (rows[0]) return fromRow(rows[0]);
  const theme = bundledTheme(DEFAULT_THEME_NAME)!;
  const range = `^${theme.manifest.version}`;
  const lock = await lockTo(DEFAULT_THEME_NAME, range);
  const inserted = await query<ConfigRow>(
    `INSERT INTO site_themes (site_id, theme_name, version_range, locked_version, locked_integrity)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id) DO UPDATE SET site_id = EXCLUDED.site_id
     RETURNING *`,
    [siteId, DEFAULT_THEME_NAME, range, lock.version, lock.integrity],
  );
  return fromRow(inserted[0]);
}

/**
 * Applies an update. Changing the theme or its range re-locks to the bundled
 * version; anything else keeps the lock, so publishes render the same bytes.
 */
export async function updateSiteTheme(siteId: string, input: unknown): Promise<SiteThemeConfig> {
  const current = await readSiteTheme(siteId);
  const next = await resolveUpdate(current, input);
  // Changing either needs a paid plan on the hosted service; clearing never does.
  if (next.customCss !== current.customCss && next.customCss !== "") await requireFeature(siteId, "customCss");
  if (JSON.stringify(next.templateOverrides) !== JSON.stringify(current.templateOverrides) && Object.keys(next.templateOverrides).length) {
    await requireFeature(siteId, "templateOverrides");
  }
  await saveSiteTheme(siteId, next);
  return next;
}

/**
 * The config an update would produce, without saving it: the same validation
 * and re-locking as a real update. Theme change previews (#66) render with it.
 */
export async function resolveUpdate(current: SiteThemeConfig, input: unknown): Promise<SiteThemeConfig> {
  // Shape first, so a bad name or range fails before any lookup.
  const raw = isRecord(input) ? input : {};
  if (raw.themeName !== undefined && (typeof raw.themeName !== "string" || !THEME_NAME.test(raw.themeName))) {
    throw new ConfigError("themeName", "is not an available theme");
  }
  if (raw.versionRange !== undefined && !isVersionRange(raw.versionRange)) throw new ConfigError("versionRange", "must be x.y.z, ^x.y.z or ~x.y.z");
  const shape = raw as { themeName?: string; versionRange?: string };
  const themeName = shape.themeName ?? current.themeName;
  const themeChanged = themeName !== current.themeName;
  // A new theme with no range locks to its newest version, and the range follows it.
  let versionRange = shape.versionRange ?? (themeChanged ? "" : current.versionRange);
  let lock = current.lock;
  if (themeChanged || versionRange !== current.versionRange) {
    lock = versionRange ? await lockTo(themeName, versionRange) : await lockToLatest(themeName);
    if (!versionRange) versionRange = `^${lock.version}`;
  }
  const target = await lockedPackage(lock.integrity);
  const update = validateUpdate(input, target.manifest, target);
  return { ...current, ...update, themeName, versionRange, lock };
}

/** Writes a resolved config, on the given connection when inside a transaction. */
export async function saveSiteTheme(
  siteId: string,
  next: SiteThemeConfig,
  run: (sql: string, params: unknown[]) => Promise<unknown> = query,
): Promise<void> {
  await run(
    `UPDATE site_themes SET theme_name = $2, version_range = $3, tokens = $4, settings = $5, custom_css = $6,
       template_overrides = $7, locks = $8, locked_version = $9, locked_integrity = $10, updated_at = now()
     WHERE site_id = $1`,
    [
      siteId,
      next.themeName,
      next.versionRange,
      JSON.stringify(next.tokens),
      JSON.stringify(next.settings),
      next.customCss,
      JSON.stringify(next.templateOverrides),
      JSON.stringify(next.locks),
      next.lock.version,
      next.lock.integrity,
    ],
  );
}

export async function readPresentation(siteId: string, fileId: string): Promise<PagePresentation> {
  const rows = await query<{ template: string; section_styles: Record<string, string[]> }>(
    "SELECT template, section_styles FROM page_presentation WHERE site_id = $1 AND file_id = $2",
    [siteId, fileId],
  );
  return rows[0] ? { template: rows[0].template, sectionStyles: rows[0].section_styles } : { template: "page", sectionStyles: {} };
}

export async function savePresentation(siteId: string, fileId: string, input: unknown): Promise<PagePresentation> {
  const config = await readSiteTheme(siteId);
  const theme = await lockedPackage(config.lock.integrity);
  const presentation = validatePresentation(input, theme.manifest);
  await query(
    `INSERT INTO page_presentation (site_id, file_id, template, section_styles) VALUES ($1, $2, $3, $4)
     ON CONFLICT (site_id, file_id) DO UPDATE SET template = EXCLUDED.template,
       section_styles = EXCLUDED.section_styles, updated_at = now()`,
    [siteId, fileId, presentation.template, JSON.stringify(presentation.sectionStyles)],
  );
  return presentation;
}

/** Everything a render of one page needs from the store. */
export type RenderContext = {
  theme: ThemePackage;
  config: SiteThemeConfig | null;
  presentation: PagePresentation | null;
};

/**
 * Reads the signed-in owner's site config for a page. Without a database or a
 * server session (sample mode, local dev), pages render with the default theme
 * and the Doc's own section styles, as before #56.
 */
export async function renderContextFor(sub: string | null, fileId: string): Promise<RenderContext> {
  if (!sub || !databaseConfigured()) {
    return { theme: bundledTheme(DEFAULT_THEME_NAME)!, config: null, presentation: null };
  }
  const siteId = await siteForOwner(sub);
  const stored = await readSiteTheme(siteId);
  // Stored custom CSS stops rendering when the plan no longer includes it (downgrade); it is kept, not deleted.
  const noCss = stored.customCss && !(await siteAllows(siteId, "customCss"));
  const noOverrides = Object.keys(stored.templateOverrides).length > 0 && !(await siteAllows(siteId, "templateOverrides"));
  const config = noCss || noOverrides ? { ...stored, customCss: noCss ? "" : stored.customCss, templateOverrides: noOverrides ? {} : stored.templateOverrides } : stored;
  const [theme, presentation] = await Promise.all([lockedPackage(config.lock.integrity), readPresentation(siteId, fileId)]);
  return { theme, config, presentation };
}

/**
 * Stored tokens and settings the locked theme does not declare, for example
 * after a theme change. They are kept and reported, never silently dropped.
 */
export function orphans(config: Pick<SiteThemeConfig, "tokens" | "settings">, theme: ThemePackage): { tokens: string[]; settings: string[] } {
  const declared = new Set((theme.manifest.settings ?? []).map((setting) => setting.id));
  return {
    tokens: orphanTokens(theme, config.tokens),
    settings: Object.keys(config.settings).filter((id) => !declared.has(id)),
  };
}

/** A theme a site can switch to. */
export type AvailableTheme = { name: string; version: string; description: string; source: "registry" | "bundled" };

/** Registry themes (newest installable version), plus bundled themes the registry does not list yet. */
export async function availableThemes(): Promise<AvailableTheme[]> {
  const published = databaseConfigured() ? await listThemes() : [];
  const out: AvailableTheme[] = published.map((v) => ({ name: v.name, version: v.version, description: v.description, source: "registry" }));
  for (const theme of bundledThemes()) {
    if (!out.some((t) => t.name === theme.manifest.name)) {
      out.push({ name: theme.manifest.name, version: theme.manifest.version, description: theme.manifest.description ?? "", source: "bundled" });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
