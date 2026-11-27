import { readdirSync, readFileSync } from "node:fs";
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
  /**
   * ES module source per block that declares `js` (#60). Optional because
   * package snapshots stored before islands existed do not have it.
   */
  blockJs?: Record<string, string>;
  tokens: Record<string, unknown>;
};

const MAX_FILE_BYTES = 256 * 1024;

function readText(file: string): string {
  // Read first and check the bytes we got, so there is no gap between a size check and the read.
  const bytes = readFileSync(file);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
  return bytes.toString("utf8");
}

/** Reads a file that may not exist, without a separate existence check. */
function readOptional(file: string): string | null {
  try {
    return readText(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function liquidFiles(root: string, dir: string, out: Record<string, string>): void {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
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
  const blockJs: Record<string, string> = {};
  for (const [name, block] of Object.entries(manifest.blocks)) {
    if (!(`blocks/${name}/block` in templates)) {
      throw new Error(`${manifest.name}: blocks/${name}/block.liquid is missing`);
    }
    const css = path.join(root, "blocks", name, "block.css");
    const source = readOptional(css);
    if (source !== null) blockCss[name] = source.trim();
    const js = readOptional(path.join(root, "blocks", name, "block.js"));
    if (block.js && js === null) throw new Error(`${manifest.name}: block "${name}" declares js but blocks/${name}/block.js is missing`);
    if (!block.js && js !== null) throw new Error(`${manifest.name}: blocks/${name}/block.js needs "js": { "load": ... } in theme.json`);
    if (js !== null) blockJs[name] = js.trim();
  }

  const base = path.join(root, "styles", "base.css");
  const tokensFile = path.join(root, "styles", "tokens.json");
  return {
    manifest,
    templates,
    baseCss: (readOptional(base) ?? "").trim(),
    blockCss,
    blockJs,
    tokens: JSON.parse(readOptional(tokensFile) ?? "{}") as Record<string, unknown>,
  };
}

const THEMES_DIR = path.join(process.cwd(), "themes");
let defaultTheme: ThemePackage | null = null;

/** The first-party default theme, @pagefirst/default, loaded once per process. */
export function getDefaultTheme(): ThemePackage {
  defaultTheme ??= loadThemeFromDir(path.join(THEMES_DIR, "default"));
  return defaultTheme;
}
