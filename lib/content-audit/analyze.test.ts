import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "@/lib/page/types";
import { analyze, DEFAULT_OPTIONS, expiredDates, findDuplicates, jaccard, pageText, toAuditPage, tokenize } from "./analyze";

const now = new Date("2026-06-01T00:00:00Z");

function page(fileId: string, ...paragraphs: string[]): Page {
  return {
    fileId,
    revisionId: "r1",
    path: fileId,
    metadata: {},
    sections: [{ id: "s", style: [], children: paragraphs.map((text, i) => ({ kind: "prose" as const, id: `p${i}`, tag: "p" as const, text })) }],
  };
}

const lorem = (n: number, seed = "alpha") => Array.from({ length: n }, (_, i) => `${seed}${i % 37}`).join(" ");

test("pageText collects prose, list items and block cells", () => {
  const p = page("a", "Hello");
  p.sections[0].children.push(
    { kind: "prose", id: "l", tag: "ul", items: ["one", "two"] },
    { kind: "block", id: "b", name: "cards", options: [], rows: [[{ id: "c", children: [{ kind: "prose", id: "x", tag: "p", text: "in a cell" }] }]] },
  );
  assert.equal(pageText(p), "Hello\none\ntwo\nin a cell");
});

test("tokenize lowercases and drops punctuation", () => {
  assert.deepEqual(tokenize("Don't stop, Mr. Smith!"), ["don't", "stop", "mr", "smith"]);
});

test("expiredDates only counts past dates that follow an expiry cue", () => {
  const text = "Offer ends March 3, 2025. Founded 2019-01-01. Valid until 2030-01-01. Expires: 2024-12-31.";
  assert.deepEqual(expiredDates(text, now), ["2024-12-31", "2025-03-03"]);
});

test("jaccard of identical and disjoint sets", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.equal(jaccard(new Set(), new Set(["b"])), 0);
});

test("near-duplicates are grouped and the rest are left alone", () => {
  const base = lorem(200);
  const a = toAuditPage(page("a", base), "A", undefined, now);
  const b = toAuditPage(page("b", `${base} extra closing words here`), "B", undefined, now);
  const c = toAuditPage(page("c", lorem(200, "zulu")), "C", undefined, now);
  const groups = findDuplicates([a, b, c], 0.8);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].pages.map((p) => p.fileId).sort(), ["a", "b"]);
  assert.ok(groups[0].similarity >= 0.8);
});

test("analyze reports stale, expired, thin and duplicate pages", () => {
  const long = lorem(200);
  const pages = [
    toAuditPage(page("old", long), "Old", "2024-01-01T00:00:00Z", now),
    toAuditPage(page("fresh", lorem(200, "beta")), "Fresh", "2026-05-20T00:00:00Z", now),
    toAuditPage(page("thin", "Just a few words."), "Thin", undefined, now),
    toAuditPage(page("promo", `${lorem(150, "gamma")} Offer ends 2025-01-01.`), "Promo", "2026-05-01T00:00:00Z", now),
    toAuditPage(page("dup", long), "Dup", "2026-05-01T00:00:00Z", now),
  ];
  const report = analyze(pages, { now, ...DEFAULT_OPTIONS });
  assert.equal(report.pagesChecked, 5);
  assert.deepEqual(report.stale.map((s) => s.fileId), ["old"]);
  assert.ok(report.stale[0].daysSinceModified > 365);
  assert.deepEqual(report.expired.map((e) => [e.fileId, e.dates]), [["promo", ["2025-01-01"]]]);
  assert.deepEqual(report.thin.map((t) => t.fileId), ["thin"]);
  assert.deepEqual(report.duplicates[0].pages.map((p) => p.fileId).sort(), ["dup", "old"]);
  assert.equal(report.duplicates[0].suggestion, "merge");
});

test("a bad modifiedTime is skipped rather than flagged", () => {
  const p = toAuditPage(page("x", lorem(200)), "X", "not a date", now);
  assert.deepEqual(analyze([p], { now, ...DEFAULT_OPTIONS }).stale, []);
});
