/**
 * The theme.json manifest. The JSON Schema in theme.schema.json is the source of
 * truth (see docs/adr/0002-theme-package-contract.md); tests validate every
 * first-party theme against it. This module checks what the engine relies on.
 */

export const ENGINE_VERSION = 1;

export type BlockLoad = "visible" | "idle" | "interaction";

export type ManifestBlock = {
  label: string;
  description?: string;
  options?: string[];
  js?: { load: BlockLoad };
  shape?: { minRows?: number; maxRows?: number; columns?: number };
};

export type ManifestSetting = {
  id: string;
  type: "text" | "boolean" | "select" | "color" | "number";
  label: string;
  default?: string | boolean | number;
  options?: string[];
};

export type FontSubset = "latin" | "latin-ext" | "cyrillic" | "cyrillic-ext" | "greek" | "vietnamese";

export type ManifestFont = {
  family: string;
  weight?: number | string;
  style?: "normal" | "italic";
  preload?: boolean;
  files: { src: string; subset: FontSubset; unicodeRange: string }[];
  fallback: { local: string[]; sizeAdjust?: string; ascentOverride?: string; descentOverride?: string; lineGapOverride?: string };
};

export type ThemeManifest = {
  name: string;
  version: string;
  engine: number;
  description?: string;
  templates: Record<string, { label: string; description?: string }>;
  blocks: Record<string, ManifestBlock>;
  sectionStyles?: string[];
  settings?: ManifestSetting[];
  permissions?: { connect?: string[]; img?: string[]; frame?: string[] };
  integrations?: string[];
  fonts?: ManifestFont[];
  budgets?: Record<string, number>;
};

const BLOCK_LOADS = new Set<BlockLoad>(["visible", "idle", "interaction"]);
const ORIGIN = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/;
const IDENTIFIER = /^[a-z][a-z0-9-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Throws with a message naming the first problem. */
export function parseManifest(value: unknown): ThemeManifest {
  if (!isRecord(value)) throw new Error("theme.json must be an object");
  if (typeof value.name !== "string" || !value.name) throw new Error("theme.json: name is required");
  if (typeof value.version !== "string" || !value.version) throw new Error("theme.json: version is required");
  if (value.engine !== ENGINE_VERSION) {
    throw new Error(`theme.json: engine ${String(value.engine)} is not supported (expected ${ENGINE_VERSION})`);
  }
  if (!isRecord(value.templates) || !isRecord(value.templates.page)) {
    throw new Error("theme.json: templates.page is required");
  }
  if (!isRecord(value.blocks)) throw new Error("theme.json: blocks is required");
  for (const name of [...Object.keys(value.templates), ...Object.keys(value.blocks)]) {
    if (!IDENTIFIER.test(name)) throw new Error(`theme.json: "${name}" is not a valid template or block name`);
  }
  for (const [name, block] of Object.entries(value.blocks)) {
    if (!isRecord(block)) throw new Error(`theme.json: block "${name}" must be an object`);
    if (block.options !== undefined && !Array.isArray(block.options)) {
      throw new Error(`theme.json: block "${name}" options must be a list`);
    }
    if (block.js !== undefined && (!isRecord(block.js) || !BLOCK_LOADS.has(block.js.load as BlockLoad))) {
      throw new Error(`theme.json: block "${name}" js.load must be one of ${[...BLOCK_LOADS].join(", ")}`);
    }
  }
  if (value.permissions !== undefined) {
    if (!isRecord(value.permissions)) throw new Error("theme.json: permissions must be an object");
    for (const [kind, origins] of Object.entries(value.permissions)) {
      if (!["connect", "img", "frame"].includes(kind)) throw new Error(`theme.json: permissions.${kind} is not supported`);
      if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === "string" && ORIGIN.test(origin))) {
        throw new Error(`theme.json: permissions.${kind} must list https origins such as https://api.example.com`);
      }
    }
  }
  if (value.fonts !== undefined) parseFonts(value.fonts);
  if (value.settings !== undefined && !Array.isArray(value.settings)) {
    throw new Error("theme.json: settings must be a list");
  }
  return value as ThemeManifest;
}

const FAMILY = /^[A-Za-z0-9 -]{1,64}$/;
const FONT_SRC = /^assets\/fonts\/[a-z0-9-]+\.woff2$/;
const UNICODE_RANGE = /^U\+[0-9A-Fa-f?-]+(,\s*U\+[0-9A-Fa-f?-]+)*$/;
const PERCENT = /^[0-9]{1,3}(\.[0-9]{1,3})?%$/;
const SUBSETS = new Set(["latin", "latin-ext", "cyrillic", "cyrillic-ext", "greek", "vietnamese"]);

/** Font declarations end up inside CSS, so every value is checked against a strict shape. */
function parseFonts(fonts: unknown): void {
  if (!Array.isArray(fonts)) throw new Error("theme.json: fonts must be a list");
  let preloads = 0;
  for (const font of fonts) {
    if (!isRecord(font) || typeof font.family !== "string" || !FAMILY.test(font.family)) {
      throw new Error("theme.json: each font needs a family of letters, digits, spaces or hyphens");
    }
    const where = `font "${font.family}"`;
    if (font.weight !== undefined && !/^[0-9]{3}( [0-9]{3})?$/.test(String(font.weight))) throw new Error(`theme.json: ${where} weight is invalid`);
    if (font.style !== undefined && font.style !== "normal" && font.style !== "italic") throw new Error(`theme.json: ${where} style is invalid`);
    if (font.preload === true) preloads += 1;
    if (!Array.isArray(font.files) || font.files.length === 0) throw new Error(`theme.json: ${where} needs files`);
    for (const file of font.files) {
      if (!isRecord(file) || typeof file.src !== "string" || !FONT_SRC.test(file.src)) throw new Error(`theme.json: ${where} file src must be assets/fonts/<name>.woff2`);
      if (!SUBSETS.has(String(file.subset))) throw new Error(`theme.json: ${where} subset is invalid`);
      if (typeof file.unicodeRange !== "string" || !UNICODE_RANGE.test(file.unicodeRange)) throw new Error(`theme.json: ${where} unicodeRange is invalid`);
    }
    const fallback = font.fallback;
    if (!isRecord(fallback) || !Array.isArray(fallback.local) || fallback.local.length === 0 || !fallback.local.every((name) => typeof name === "string" && FAMILY.test(name))) {
      throw new Error(`theme.json: ${where} needs fallback.local font names`);
    }
    for (const key of ["sizeAdjust", "ascentOverride", "descentOverride", "lineGapOverride"]) {
      if (fallback[key] !== undefined && !(typeof fallback[key] === "string" && PERCENT.test(fallback[key] as string))) {
        throw new Error(`theme.json: ${where} fallback.${key} must be a percentage`);
      }
    }
  }
  if (preloads > 1) throw new Error("theme.json: at most one font may be preloaded");
}
