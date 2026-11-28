import type { ThemePackage } from "./package";

/**
 * Automated checks every submitted theme version must pass (#68), whoever
 * publishes it. They are static and conservative: they stop the obvious ways a
 * theme could load code or data the manifest does not declare. They do not
 * replace human review for verified themes; they decide what never gets in.
 */
export type Finding = { rule: string; file: string; message: string };

const JS_RULES: { rule: string; pattern: RegExp; message: string }[] = [
  { rule: "no-eval", pattern: /\beval\s*\(/, message: "eval() is not allowed" },
  { rule: "no-new-function", pattern: /\bnew\s+Function\b|\bFunction\s*\(/, message: "the Function constructor is not allowed" },
  { rule: "no-document-cookie", pattern: /\bdocument\s*\.\s*cookie\b/, message: "document.cookie is not allowed" },
  { rule: "no-remote-import", pattern: /\bimport\s*\(\s*[^)'"`\s][^)]*\)|\bimport\s*\(\s*['"`]https?:\/\//, message: "dynamic import() of a computed or remote URL is not allowed" },
  { rule: "no-remote-import", pattern: /\bimport\b[^;\n]*\bfrom\s*['"]https?:\/\//, message: "importing a module from a remote URL is not allowed" },
  { rule: "no-document-write", pattern: /\bdocument\s*\.\s*write(ln)?\s*\(/, message: "document.write is not allowed" },
];

const ORIGIN = /https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi;
/** Namespace and spec URLs that appear in markup or code without any request being made. */
const INERT_HOSTS = new Set(["www.w3.org", "w3.org", "schema.org"]);

function declaredHosts(theme: ThemePackage): Set<string> {
  const hosts = new Set<string>();
  for (const list of Object.values(theme.manifest.permissions ?? {})) {
    for (const origin of list ?? []) {
      try {
        hosts.add(new URL(origin).hostname);
      } catch {
        // A malformed origin is the manifest check's business, not this one.
      }
    }
  }
  return hosts;
}

export function checkTheme(theme: ThemePackage): Finding[] {
  const findings: Finding[] = [];
  const declared = declaredHosts(theme);

  for (const [block, source] of Object.entries(theme.blockJs ?? {})) {
    const file = `blocks/${block}/block.js`;
    for (const { rule, pattern, message } of JS_RULES) {
      if (pattern.test(source)) findings.push({ rule, file, message });
    }
    for (const match of source.matchAll(ORIGIN)) {
      const host = match[1]!.toLowerCase();
      if (!declared.has(host) && !INERT_HOSTS.has(host)) {
        findings.push({ rule: "undeclared-origin", file, message: `calls ${host}, which theme.json permissions do not declare` });
      }
    }
  }

  const css: [string, string][] = [["base.css", theme.baseCss], ...Object.entries(theme.blockCss).map(([block, source]): [string, string] => [`blocks/${block}/block.css`, source])];
  for (const [file, source] of css) {
    if (/@import\b/i.test(source)) findings.push({ rule: "no-css-import", file, message: "@import in CSS is not allowed; it blocks rendering and loads code you cannot budget" });
    for (const match of source.matchAll(/url\(\s*['"]?(https?:\/\/[^)'"\s]+)/gi)) {
      findings.push({ rule: "no-remote-css-url", file, message: `CSS loads ${new URL(match[1]!).hostname}; ship the file in the theme instead` });
    }
  }
  return dedupe(findings);
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule}|${finding.file}|${finding.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export const describeFindings = (findings: Finding[]): string => findings.map((f) => `${f.file}: ${f.message} (${f.rule})`).join("; ");
