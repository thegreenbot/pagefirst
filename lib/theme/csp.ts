import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/**
 * CSP for published pages: only the page's own <style> elements, the site's own
 * stylesheet files when the page defers CSS (#59), and no script at all unless
 * the page has islands (#60): then the inline loader by hash and the site's own
 * modules.
 */
export function publishedCsp(styleTexts: string[], extra: { selfStyles?: boolean; scripts?: string[] } = {}): string {
  const scripts = extra.scripts ?? [];
  return [
    "default-src 'none'",
    scripts.length ? `script-src 'self' ${scripts.map(sha256).join(" ")}` : "script-src 'none'",
    `style-src ${extra.selfStyles ? "'self' " : ""}${styleTexts.map(sha256).join(" ")}`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** Server-side helpers the engine uses to split CSS (#59). */
export const nodeOptimizer = {
  gzipSize: (text: string) => gzipSync(text).length,
  hash: (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16),
};
