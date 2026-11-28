/**
 * A small line diff, for showing what a theme upgrade changed in a template a
 * site has overridden (#65). Browser-safe; no dependencies.
 */

/** Unified-style diff of two texts: "+" added, "-" removed, " " kept. Empty when equal. */
export function lineDiff(before: string, after: string): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence table; templates are capped at 64 KB so this stays small.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(`-${a[i++]}`);
    else out.push(`+${b[j++]}`);
  }
  while (i < a.length) out.push(`-${a[i++]}`);
  while (j < b.length) out.push(`+${b[j++]}`);
  return out.join("\n");
}

export type OverrideConflict = {
  path: string;
  /** "removed": the new theme version has no such template. "changed": its original changed. */
  status: "removed" | "changed";
  /** What the upgrade changed in the original (old original to new original). */
  diff: string;
};

/**
 * The overridden templates whose original differs between the locked theme
 * version and the one a change would lock to. The site's own override is kept
 * either way; this tells the author what it no longer matches.
 */
export function overrideConflicts(
  overrides: Record<string, string>,
  from: Record<string, string>,
  to: Record<string, string>,
): OverrideConflict[] {
  const out: OverrideConflict[] = [];
  for (const path of Object.keys(overrides).sort()) {
    const before = from[path];
    if (before === undefined) continue;
    const after = to[path];
    if (after === undefined) out.push({ path, status: "removed", diff: lineDiff(before, "") });
    else if (after !== before) out.push({ path, status: "changed", diff: lineDiff(before, after) });
  }
  return out;
}
