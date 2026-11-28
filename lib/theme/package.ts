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
  /** Binary files the manifest names (fonts, #62), base64 encoded so a package snapshot stays JSON. */
  files?: Record<string, string>;
};

const MAX_FILE_BYTES = 256 * 1024;
/** Limits for a whole package, so an archive from the registry cannot exhaust memory. */
export const PACKAGE_LIMITS = { files: 512, totalBytes: 4 * 1024 * 1024, pathLength: 200 };

/** A package's files by POSIX path relative to its root, e.g. "theme.json", "blocks/hero/block.css". */
export type ThemeFiles = Map<string, Uint8Array>;

const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Rejects absolute paths, `.` and `..` segments and anything outside a plain character set. */
export function isSafePackagePath(file: string): boolean {
  return file.length <= PACKAGE_LIMITS.pathLength && SAFE_PATH.test(file);
}

/** Reads every regular file under a theme directory, with the same limits an archive gets. */
export function readThemeDir(root: string): ThemeFiles {
  const files: ThemeFiles = new Map();
  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) {
        if (!isSafePackagePath(rel)) throw new Error(`${rel}: file names may use letters, digits, ".", "_" and "-" only`);
        // Read first and check the bytes we got, so there is no gap between a size check and the read.
        const bytes = readFileSync(path.join(root, rel));
        if (bytes.length > MAX_FILE_BYTES) throw new Error(`${rel} is larger than ${MAX_FILE_BYTES} bytes`);
        total += bytes.length;
        files.set(rel, new Uint8Array(bytes));
        if (files.size > PACKAGE_LIMITS.files || total > PACKAGE_LIMITS.totalBytes) throw new Error(`${root} is larger than a theme package may be`);
      }
    }
  };
  walk("");
  return files;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Builds a theme package from its files and checks it against its manifest. */
export function loadThemeFromFiles(files: ThemeFiles): ThemePackage {
  const text = (file: string): string | null => {
    const bytes = files.get(file);
    if (!bytes) return null;
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${file} is larger than ${MAX_FILE_BYTES} bytes`);
    return decoder.decode(bytes);
  };
  const manifestText = text("theme.json");
  if (manifestText === null) throw new Error("theme.json is missing");
  const manifest = parseManifest(JSON.parse(manifestText));

  const templates: Record<string, string> = {};
  for (const file of [...files.keys()].sort()) {
    if (/^(layouts|partials|blocks)\/.+\.liquid$/.test(file)) templates[file.slice(0, -".liquid".length)] = text(file)!.replace(/\n$/, "");
  }
  for (const name of Object.keys(manifest.templates)) {
    if (!(`layouts/${name}` in templates)) throw new Error(`${manifest.name}: layouts/${name}.liquid is missing`);
  }
  const blockCss: Record<string, string> = {};
  const blockJs: Record<string, string> = {};
  for (const [name, block] of Object.entries(manifest.blocks)) {
    if (!(`blocks/${name}/block` in templates)) {
      throw new Error(`${manifest.name}: blocks/${name}/block.liquid is missing`);
    }
    const source = text(`blocks/${name}/block.css`);
    if (source !== null) blockCss[name] = source.trim();
    const js = text(`blocks/${name}/block.js`);
    if (block.js && js === null) throw new Error(`${manifest.name}: block "${name}" declares js but blocks/${name}/block.js is missing`);
    if (!block.js && js !== null) throw new Error(`${manifest.name}: blocks/${name}/block.js needs "js": { "load": ... } in theme.json`);
    if (js !== null) blockJs[name] = js.trim();
  }

  const binary: Record<string, string> = {};
  for (const font of manifest.fonts ?? []) {
    for (const file of font.files) {
      // parseManifest allows only assets/fonts/<name>.woff2.
      const bytes = files.get(file.src);
      if (!bytes) throw new Error(`${manifest.name}: ${file.src} is missing`);
      if (bytes.length > MAX_FILE_BYTES) throw new Error(`${file.src} is larger than ${MAX_FILE_BYTES} bytes`);
      binary[file.src] = Buffer.from(bytes).toString("base64");
    }
  }

  return {
    manifest,
    templates,
    baseCss: (text("styles/base.css") ?? "").trim(),
    blockCss,
    blockJs,
    files: binary,
    tokens: JSON.parse(text("styles/tokens.json") ?? "{}") as Record<string, unknown>,
  };
}

/** Reads a theme package directory into memory and checks it against its manifest. */
export function loadThemeFromDir(root: string): ThemePackage {
  return loadThemeFromFiles(readThemeDir(root));
}

const THEMES_DIR = path.join(process.cwd(), "themes");
let defaultTheme: ThemePackage | null = null;

/** The first-party default theme, @pagefirst/default, loaded once per process. */
export function getDefaultTheme(): ThemePackage {
  defaultTheme ??= loadThemeFromDir(path.join(THEMES_DIR, "default"));
  return defaultTheme;
}

let bundled: ThemePackage[] | null = null;

/** Every first-party theme shipped under themes/, loaded once per process. */
export function getBundledThemes(): ThemePackage[] {
  bundled ??= readdirSync(THEMES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((dir) => (dir === "default" ? getDefaultTheme() : loadThemeFromDir(path.join(THEMES_DIR, dir))));
  return bundled;
}
