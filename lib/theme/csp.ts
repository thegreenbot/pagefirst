import { createHash } from "node:crypto";

/** CSP for published pages: no script at all, only the page's own <style>. */
export function publishedCsp(styleText: string): string {
  const hash = createHash("sha256").update(styleText).digest("base64");
  return [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'sha256-${hash}'`,
    "img-src 'self' https: data:",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
