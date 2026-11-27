import type { ThemePackage } from "./package";

/**
 * Design tokens (#57). A theme declares them in styles/tokens.json with
 * defaults; a site overrides values. They compile to CSS custom properties
 * (`--pf-<name>`) in their own cascade layer, so changing one never needs a
 * template render. Browser-safe.
 */

export type TokenType = "color" | "font" | "size" | "number" | "other";
export type TokenDef = { type: TokenType; value: string | number; label: string };
export type TokenValues = Record<string, string | number>;

const TOKEN_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** No characters that end a declaration, a block or the <style> element. */
const TOKEN_VALUE = /^[^;{}<>\\\u0000-\u001f]{0,200}$/;
const TYPES = new Set<TokenType>(["color", "font", "size", "number", "other"]);

/** Cascade layers, lowest precedence first. Customer CSS (#65) always wins. */
export const LAYER_ORDER = "@layer reset,tokens,theme,blocks,customer;";

export function isTokenName(name: string): boolean {
  return TOKEN_NAME.test(name);
}

export function isTokenValue(value: unknown): value is string | number {
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && TOKEN_VALUE.test(value);
}

/** The theme's declared tokens. Malformed entries are skipped. */
export function tokenDefs(theme: Pick<ThemePackage, "tokens">): Record<string, TokenDef> {
  const out: Record<string, TokenDef> = {};
  for (const [name, raw] of Object.entries(theme.tokens ?? {})) {
    if (!isTokenName(name) || typeof raw !== "object" || raw === null) continue;
    const def = raw as Record<string, unknown>;
    const type = TYPES.has(def.type as TokenType) ? (def.type as TokenType) : "other";
    if (!isTokenValue(def.value)) continue;
    out[name] = { type, value: def.value, label: typeof def.label === "string" ? def.label : name };
  }
  return out;
}

/** Theme defaults with the site's values on top. Site values for undeclared tokens are ignored. */
export function resolveTokens(theme: Pick<ThemePackage, "tokens">, site: Record<string, unknown> = {}): TokenValues {
  const out: TokenValues = {};
  for (const [name, def] of Object.entries(tokenDefs(theme))) {
    const value = Object.hasOwn(site, name) ? site[name] : undefined;
    out[name] = isTokenValue(value) ? value : def.value;
  }
  return out;
}

/** Site token names the theme does not declare, e.g. after a theme change. */
export function orphanTokens(theme: Pick<ThemePackage, "tokens">, site: Record<string, unknown>): string[] {
  const defs = tokenDefs(theme);
  return Object.keys(site).filter((name) => !Object.hasOwn(defs, name));
}

export function tokensCss(values: TokenValues): string {
  const declarations = Object.entries(values)
    .filter(([name, value]) => isTokenName(name) && isTokenValue(value))
    .map(([name, value]) => `--pf-${name}:${value}`)
    .join(";");
  return `${LAYER_ORDER}@layer tokens{:root{${declarations}}}`;
}
