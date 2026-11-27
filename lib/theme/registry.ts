import { createHash } from "node:crypto";
import { getDefaultTheme, type ThemePackage } from "./package";

/**
 * The themes this app can lock a site to. Until the registry (#64) exists,
 * that is the themes bundled under themes/.
 */
export function bundledTheme(name: string): ThemePackage | null {
  const theme = getDefaultTheme();
  return theme.manifest.name === name ? theme : null;
}

export const DEFAULT_THEME_NAME = "@pagefirst/default";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Subresource-integrity style hash of a package's exact contents. */
export function packageIntegrity(theme: ThemePackage): string {
  return `sha256-${createHash("sha256").update(canonical(theme)).digest("base64")}`;
}

/** Does `version` satisfy `range`? Supports an exact version, "^x.y.z" and "~x.y.z". */
export function satisfies(version: string, range: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const v = parse(version);
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "";
  const r = parse(op ? range.slice(1) : range);
  if (!v || !r) return false;
  if (!op) return version === range;
  const atLeast = v[0] > r[0] || (v[0] === r[0] && (v[1] > r[1] || (v[1] === r[1] && v[2] >= r[2])));
  if (!atLeast) return false;
  if (op === "~") return v[0] === r[0] && v[1] === r[1];
  return r[0] > 0 ? v[0] === r[0] : r[1] > 0 ? v[0] === 0 && v[1] === r[1] : v[0] === 0 && v[1] === 0 && v[2] === r[2];
}

export function isVersionRange(value: unknown): value is string {
  return typeof value === "string" && /^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}
