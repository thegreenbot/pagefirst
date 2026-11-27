import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parseManifest, type ThemeManifest } from "./manifest";

/** A theme package held in memory. Rendering never touches the file system. */
export type ThemePackage = {
  manifest: ThemeManifest;
  /** Liquid sources keyed by path without extension, e.g. "layouts/page", "blocks/hero/block". */
  templates: Record<string, string>;
  baseCss: string;
  /** CSS per declared block that ships a block.css. */
  blockCss: Record<string, string>;
  tokens: Record<string, unknown>;
};

const MAX_FILE_BYTES = 256 * 1024;

function readText(file: string): string {
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  return readFileSync(file, "utf8");
}

function liquidFiles(root: string, dir: string, out: Record<string, string>): void {
  const full = path.join(root, dir);
  if (!existsSync(full)) return;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) liquidFiles(root, rel, out);
    else if (entry.isFile() && entry.name.endsWith(".liquid")) {
      out[rel.slice(0, -".liquid".length)] = readText(path.join(root, rel)).replace(/\n$/, "");
    }
  }
}

/** Reads a theme package directory into memory and checks it against its manifest. */
export function loadThemeFromDir(root: string): ThemePackage {
  const manifest = parseManifest(JSON.parse(readText(path.join(root, "theme.json"))));
  const templates: Record<string, string> = {};
  for (const dir of ["layouts", "partials", "blocks"]) liquidFiles(root, dir, templates);

  for (const name of Object.keys(manifest.templates)) {
    if (!(`layouts/${name}` in templates)) throw new Error(`${manifest.name}: layouts/${name}.liquid is missing`);
  }
  const blockCss: Record<string, string> = {};
  for (const name of Object.keys(manifest.blocks)) {
    if (!(`blocks/${name}/block` in templates)) {
      throw new Error(`${manifest.name}: blocks/${name}/block.liquid is missing`);
    }
    const css = path.join(root, "blocks", name, "block.css");
    if (existsSync(css)) blockCss[name] = readText(css).trim();
  }

  const base = path.join(root, "styles", "base.css");
  const tokensFile = path.join(root, "styles", "tokens.json");
  return {
    manifest,
    templates,
    baseCss: existsSync(base) ? readText(base).trim() : "",
    blockCss,
    tokens: existsSync(tokensFile) ? (JSON.parse(readText(tokensFile)) as Record<string, unknown>) : {},
  };
}

const THEMES_DIR = path.join(process.cwd(), "themes");
let defaultTheme: ThemePackage | null = null;

/** The first-party default theme, @pagefirst/default, loaded once per process. */
export function getDefaultTheme(): ThemePackage {
  defaultTheme ??= loadThemeFromDir(path.join(THEMES_DIR, "default"));
  return defaultTheme;
}
