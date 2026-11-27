import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * CSP for published pages: no script at all, only the page's own <style> elements, and
 * the site's own stylesheet files when the page defers CSS (#59).
 */
export function publishedCsp(styleTexts: string[], extra: { selfStyles?: boolean } = {}): string {
  const hashes = styleTexts.map((text) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`).join(" ");
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src ${extra.selfStyles ? "'self' " : ""}${hashes}`,
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
