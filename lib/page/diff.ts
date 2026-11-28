import type { Block, DocsDocument, Node, Page, Prose, ProseTag, Section } from "./types";

/**
 * Node-level page diff (#31, docs/adr/0006-import-model.md). A pure function
 * from two parsed pages to an ordered, serialisable change list: no I/O, no
 * clock, no randomness. The same list powers the review UI, the API's dry-run
 * report and audit entries.
 *
 * Identity is the named-range id of a node or section. Cells have no stable id
 * and are addressed by row and column. Text changes carry a word-level diff for
 * display; they are still one whole-node change when merged.
 */

export type TextSegment = { op: "equal" | "insert" | "delete"; text: string };
export type Place = { sectionId: string; index: number };
export type ImageRef = { driveFileId: string; alt: string };

export type PageChange =
  | { kind: "meta.added"; key: string; after: string }
  | { kind: "meta.removed"; key: string; before: string }
  | { kind: "meta.changed"; key: string; before: string; after: string }
  | { kind: "section.added"; sectionId: string; index: number; section: Section }
  | { kind: "section.removed"; sectionId: string; section: Section }
  | { kind: "section.moved"; sectionId: string; from: number; to: number }
  | { kind: "section.style"; sectionId: string; before: string[]; after: string[] }
  | { kind: "node.added"; nodeId: string; at: Place; node: Node }
  /** Content added in the Doc that has no named range yet (adopted by #32). */
  | { kind: "node.untracked"; nodeId: string; at: Place; node: Node }
  | { kind: "node.removed"; nodeId: string; from: Place; node: Node }
  | { kind: "node.moved"; nodeId: string; from: Place; to: Place }
  | { kind: "prose.text"; nodeId: string; before: string; after: string; diff: TextSegment[] }
  | { kind: "prose.tag"; nodeId: string; before: ProseTag; after: ProseTag }
  | { kind: "image.changed"; nodeId: string; before: ImageRef | null; after: ImageRef | null }
  | { kind: "block.name"; nodeId: string; before: string; after: string }
  | { kind: "block.options"; nodeId: string; before: string[]; after: string[] }
  | { kind: "block.shape"; nodeId: string; before: number[]; after: number[] }
  | { kind: "cell.content"; nodeId: string; row: number; col: number; before: Prose[]; after: Prose[]; diff: TextSegment[] };

export type DiffOptions = {
  /** Ids of nodes in `next` the Doc holds without a named range. See `untrackedNodeIds`. */
  untracked?: ReadonlySet<string>;
};

const MAX_DIFF_CELLS = 4_000_000;

/** Splits into words and the whitespace between them, so joining the tokens restores the text. */
function tokens(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? [];
}

/** Word-level diff. Adjacent segments of one kind are merged. */
export function textDiff(before: string, after: string): TextSegment[] {
  if (before === after) return before ? [{ op: "equal", text: before }] : [];
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: TextSegment[] = [];
  const push = (op: TextSegment["op"], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  push("equal", a.slice(0, start).join(""));
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    push("delete", midA.join(""));
    push("insert", midB.join(""));
  } else {
    // Longest common subsequence over the changed middle.
    const w = midB.length + 1;
    const table = new Uint32Array((midA.length + 1) * w);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * w + j] = midA[i] === midB[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        push("equal", midA[i]!);
        i++;
        j++;
      } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
        push("delete", midA[i++]!);
      } else {
        push("insert", midB[j++]!);
      }
    }
    while (i < midA.length) push("delete", midA[i++]!);
    while (j < midB.length) push("insert", midB[j++]!);
  }
  push("equal", a.slice(endA).join(""));
  return out;
}

/** Ids from `items` that appear in the same relative order in both lists. */
function stableIds(from: readonly string[], to: readonly string[]): Set<string> {
  const inTo = new Set(to);
  const a = from.filter((id) => inTo.has(id));
  const inFrom = new Set(from);
  const b = to.filter((id) => inFrom.has(id));
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j] ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
    else j++;
  }
  return keep;
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((value, i) => value === y[i]);
}

function sameImage(a: ImageRef | undefined, b: ImageRef | undefined): boolean {
  return (a?.driveFileId ?? null) === (b?.driveFileId ?? null) && (a?.alt ?? "") === (b?.alt ?? "");
}

function proseText(node: Prose): string {
  return node.items ? node.items.join("\n") : (node.text ?? "");
}

function sameProse(a: Prose, b: Prose): boolean {
  return a.tag === b.tag && proseText(a) === proseText(b) && sameImage(a.image, b.image) && sameList(a.items, b.items);
}

function cellText(children: readonly Prose[]): string {
  return children.map((child) => (child.image ? `[image ${child.image.driveFileId}: ${child.image.alt}]` : proseText(child))).join("\n");
}

type Located = { node: Node; sectionId: string; index: number };

function locate(page: Page): Map<string, Located> {
  const found = new Map<string, Located>();
  for (const section of page.sections) section.children.forEach((node, index) => found.set(node.id, { node, sectionId: section.id, index }));
  return found;
}

function diffProse(change: PageChange[], base: Prose, next: Prose): void {
  if (base.tag !== next.tag) change.push({ kind: "prose.tag", nodeId: next.id, before: base.tag, after: next.tag });
  if (!sameImage(base.image, next.image)) {
    change.push({ kind: "image.changed", nodeId: next.id, before: base.image ?? null, after: next.image ?? null });
  }
  const before = proseText(base);
  const after = proseText(next);
  if (before !== after || !sameList(base.items, next.items)) {
    change.push({ kind: "prose.text", nodeId: next.id, before, after, diff: textDiff(before, after) });
  }
}

function diffBlock(change: PageChange[], base: Block, next: Block): void {
  if (base.name !== next.name) change.push({ kind: "block.name", nodeId: next.id, before: base.name, after: next.name });
  if (!sameList(base.options, next.options)) change.push({ kind: "block.options", nodeId: next.id, before: [...base.options], after: [...next.options] });
  const shape = (block: Block) => block.rows.map((row) => row.length);
  if (!sameList(shape(base).map(String), shape(next).map(String))) {
    change.push({ kind: "block.shape", nodeId: next.id, before: shape(base), after: shape(next) });
  }
  const rows = Math.max(base.rows.length, next.rows.length);
  for (let row = 0; row < rows; row++) {
    const cols = Math.max(base.rows[row]?.length ?? 0, next.rows[row]?.length ?? 0);
    for (let col = 0; col < cols; col++) {
      const before = base.rows[row]?.[col]?.children ?? [];
      const after = next.rows[row]?.[col]?.children ?? [];
      if (before.length === after.length && before.every((child, i) => sameProse(child, after[i]!))) continue;
      change.push({ kind: "cell.content", nodeId: next.id, row, col, before: structuredClone(before), after: structuredClone(after), diff: textDiff(cellText(before), cellText(after)) });
    }
  }
}

/**
 * Everything that differs between `base` and `next`, in a fixed order: metadata
 * by key, sections, then nodes in `next`'s order, then removals in `base`'s.
 * `diffPages(p, p)` is always empty.
 */
export function diffPages(base: Page, next: Page, options: DiffOptions = {}): PageChange[] {
  const changes: PageChange[] = [];

  for (const key of Object.keys(next.metadata).sort()) {
    if (!(key in base.metadata)) changes.push({ kind: "meta.added", key, after: next.metadata[key]! });
    else if (base.metadata[key] !== next.metadata[key]) changes.push({ kind: "meta.changed", key, before: base.metadata[key]!, after: next.metadata[key]! });
  }
  for (const key of Object.keys(base.metadata).sort()) {
    if (!(key in next.metadata)) changes.push({ kind: "meta.removed", key, before: base.metadata[key]! });
  }

  const baseSections = new Map(base.sections.map((section, index) => [section.id, { section, index }]));
  const nextSections = new Map(next.sections.map((section, index) => [section.id, { section, index }]));
  const sectionsInOrder = stableIds(base.sections.map((s) => s.id), next.sections.map((s) => s.id));
  next.sections.forEach((section, index) => {
    const before = baseSections.get(section.id);
    if (!before) changes.push({ kind: "section.added", sectionId: section.id, index, section: structuredClone(section) });
    else {
      if (!sectionsInOrder.has(section.id)) changes.push({ kind: "section.moved", sectionId: section.id, from: before.index, to: index });
      if (!sameList(before.section.style, section.style)) changes.push({ kind: "section.style", sectionId: section.id, before: [...before.section.style], after: [...section.style] });
    }
  });
  for (const section of base.sections) {
    if (!nextSections.has(section.id)) changes.push({ kind: "section.removed", sectionId: section.id, section: structuredClone(section) });
  }

  const before = locate(base);
  const after = locate(next);
  // Order within a section only counts for nodes that stayed in that section.
  const staysIn = (id: string) => before.get(id)?.sectionId === after.get(id)?.sectionId;
  const stable = new Set<string>();
  for (const section of next.sections) {
    const nextIds = section.children.map((node) => node.id).filter((id) => before.has(id) && staysIn(id));
    const baseIds = (baseSections.get(section.id)?.section.children ?? []).map((node) => node.id).filter((id) => after.has(id) && staysIn(id));
    for (const id of stableIds(baseIds, nextIds)) stable.add(id);
  }

  for (const section of next.sections) {
    section.children.forEach((node, index) => {
      const there = before.get(node.id);
      const at: Place = { sectionId: section.id, index };
      if (!there) {
        const kind = options.untracked?.has(node.id) ? "node.untracked" : "node.added";
        changes.push({ kind, nodeId: node.id, at, node: structuredClone(node) });
        return;
      }
      if (there.sectionId !== section.id || !stable.has(node.id)) {
        changes.push({ kind: "node.moved", nodeId: node.id, from: { sectionId: there.sectionId, index: there.index }, to: at });
      }
      if (there.node.kind === "prose" && node.kind === "prose") diffProse(changes, there.node, node);
      else if (there.node.kind === "block" && node.kind === "block") diffBlock(changes, there.node, node);
      else {
        // A prose node became a block or the reverse: one removal and one addition.
        changes.push({ kind: "node.removed", nodeId: node.id, from: { sectionId: there.sectionId, index: there.index }, node: structuredClone(there.node) });
        changes.push({ kind: "node.added", nodeId: node.id, at, node: structuredClone(node) });
      }
    });
  }
  for (const section of base.sections) {
    section.children.forEach((node, index) => {
      if (!after.has(node.id)) changes.push({ kind: "node.removed", nodeId: node.id, from: { sectionId: section.id, index }, node: structuredClone(node) });
    });
  }
  return changes;
}

/**
 * Ids of `page`'s nodes and sections that the Doc holds without a named range:
 * the parser gave them a fresh id, so they are content added directly in the
 * Doc. Pass the result as `DiffOptions.untracked`.
 */
export function untrackedNodeIds(doc: DocsDocument, page: Page): Set<string> {
  const named = new Set<string>();
  for (const [key, value] of Object.entries(doc.namedRanges ?? {})) {
    const name = value.name ?? key;
    if (name.startsWith("pg/node/")) named.add(name.slice("pg/node/".length));
  }
  const untracked = new Set<string>();
  for (const section of page.sections) for (const node of section.children) if (!named.has(node.id)) untracked.add(node.id);
  return untracked;
}
