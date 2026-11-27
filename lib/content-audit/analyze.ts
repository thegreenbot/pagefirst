import type { Node, Page } from "@/lib/page/types";

/**
 * Content audit (#50): flags pages that need a human. Pure functions over parsed
 * pages, so the same report can be served over the API and, later, MCP.
 */

export type AuditPage = {
  fileId: string;
  path: string;
  title: string;
  revisionId: string;
  /** Drive's last-modified time, when known. Staleness is skipped without it. */
  modifiedTime?: string;
  text: string;
  words: number;
  /** Dates found in the text that are already in the past. */
  expiredDates: string[];
};

export type AuditOptions = {
  now: Date;
  /** A page not modified for this many days is stale. */
  staleDays: number;
  /** Fewer words than this makes a page thin. */
  thinWords: number;
  /** Jaccard similarity of word shingles at or above this makes two pages near-duplicates. */
  duplicateThreshold: number;
};

export const DEFAULT_OPTIONS: Omit<AuditOptions, "now"> = { staleDays: 365, thinWords: 120, duplicateThreshold: 0.8 };

export type Finding = { fileId: string; path: string; title: string };
export type StaleFinding = Finding & { modifiedTime: string; daysSinceModified: number };
export type ExpiredFinding = Finding & { dates: string[] };
export type ThinFinding = Finding & { words: number };
export type DuplicateGroup = { similarity: number; pages: Finding[]; suggestion: "merge" | "rewrite" };

export type AuditReport = {
  generatedAt: string;
  options: Omit<AuditOptions, "now">;
  pagesChecked: number;
  stale: StaleFinding[];
  expired: ExpiredFinding[];
  thin: ThinFinding[];
  duplicates: DuplicateGroup[];
};

function nodeText(node: Node): string[] {
  if (node.kind === "prose") return [node.text ?? "", ...(node.items ?? []), node.image?.alt ?? ""];
  return [...node.rows.flatMap((row) => row.flatMap((cell) => cell.children.flatMap(nodeText)))];
}

/** All visible text of a page, one chunk per line. */
export function pageText(page: Page): string {
  return page.sections.flatMap((s) => s.children.flatMap(nodeText)).map((t) => t.trim()).filter(Boolean).join("\n");
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const LONG = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi");
// Only dates the text itself marks as an end: "expires 2024-01-31", "valid until March 3, 2025".
const CUE = /(expires?|expiry|expiration|valid (?:until|through|till)|offer ends|ends on|until|deadline|due)\s*(?:on|:)?\s*$/i;

/** Dates in the text that follow an expiry cue and are before `now`, as YYYY-MM-DD. */
export function expiredDates(text: string, now: Date): string[] {
  const found = new Set<string>();
  const consider = (match: RegExpExecArray, iso: string) => {
    const before = text.slice(Math.max(0, match.index - 24), match.index);
    if (!CUE.test(before)) return;
    const when = new Date(`${iso}T23:59:59Z`);
    if (!Number.isNaN(when.getTime()) && when < now) found.add(iso);
  };
  for (const m of text.matchAll(ISO)) consider(m as RegExpExecArray, m[0]);
  for (const m of text.matchAll(LONG)) {
    const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    consider(m as RegExpExecArray, `${m[3]}-${String(month).padStart(2, "0")}-${m[2].padStart(2, "0")}`);
  }
  return [...found].sort();
}

export function toAuditPage(page: Page, title: string, modifiedTime: string | undefined, now: Date): AuditPage {
  const text = pageText(page);
  return {
    fileId: page.fileId,
    path: page.path,
    title,
    revisionId: page.revisionId,
    modifiedTime,
    text,
    words: tokenize(text).length,
    expiredDates: expiredDates(text, now),
  };
}

const SHINGLE = 4;

function shingles(words: string[]): Set<string> {
  const out = new Set<string>();
  if (words.length < SHINGLE) {
    if (words.length) out.add(words.join(" "));
    return out;
  }
  for (let i = 0; i <= words.length - SHINGLE; i++) out.add(words.slice(i, i + SHINGLE).join(" "));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) shared++;
  return shared / (a.size + b.size - shared);
}

const ref = (p: AuditPage): Finding => ({ fileId: p.fileId, path: p.path, title: p.title });

/** Groups pages whose text overlaps heavily. Pairs are linked transitively. */
export function findDuplicates(pages: AuditPage[], threshold: number): DuplicateGroup[] {
  const sets = pages.map((p) => shingles(tokenize(p.text)));
  const parent = pages.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const best = new Map<number, number>();
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const score = jaccard(sets[i], sets[j]);
      if (score < threshold) continue;
      parent[find(j)] = find(i);
      best.set(i, Math.max(best.get(i) ?? 0, score));
      best.set(j, Math.max(best.get(j) ?? 0, score));
    }
  }
  const groups = new Map<number, number[]>();
  for (const i of best.keys()) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
  return [...groups.values()]
    .map((members) => {
      const similarity = Math.min(...members.map((i) => best.get(i) ?? 0));
      return {
        similarity: Math.round(similarity * 100) / 100,
        pages: members.map((i) => ref(pages[i])),
        // Near-identical pages are merge candidates; looser overlap usually needs a rewrite to differentiate.
        suggestion: (similarity >= 0.95 ? "merge" : "rewrite") as "merge" | "rewrite",
      };
    })
    .sort((a, b) => b.similarity - a.similarity);
}

export function analyze(pages: AuditPage[], options: AuditOptions): AuditReport {
  const { now, ...rest } = options;
  const stale: StaleFinding[] = [];
  for (const p of pages) {
    if (!p.modifiedTime) continue;
    const modified = new Date(p.modifiedTime);
    if (Number.isNaN(modified.getTime())) continue;
    const days = Math.floor((now.getTime() - modified.getTime()) / 86_400_000);
    if (days >= options.staleDays) stale.push({ ...ref(p), modifiedTime: p.modifiedTime, daysSinceModified: days });
  }
  stale.sort((a, b) => b.daysSinceModified - a.daysSinceModified);
  return {
    generatedAt: now.toISOString(),
    options: rest,
    pagesChecked: pages.length,
    stale,
    expired: pages.filter((p) => p.expiredDates.length).map((p) => ({ ...ref(p), dates: p.expiredDates })),
    thin: pages.filter((p) => p.words < options.thinWords).map((p) => ({ ...ref(p), words: p.words })).sort((a, b) => a.words - b.words),
    duplicates: findDuplicates(pages, options.duplicateThreshold),
  };
}
