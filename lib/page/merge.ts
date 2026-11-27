import { diffPages, type PageChange } from "./diff";
import type { Block, Cell, Node, Page, Prose, Section } from "./types";

/**
 * Three-way merge of a Doc's changes with a local draft (#33,
 * docs/adr/0006-import-model.md). A pure function: no I/O, no clock.
 *
 *   base   the page as of the last snapshot (what both sides started from)
 *   doc    the page as the Doc is now
 *   draft  the editor's uncommitted state, or null for an automated import
 *
 * The result is the Doc's page with the draft's own changes carried over. The
 * unit of conflict is the node (a prose node's tag, text or image; a block's
 * name, options and each cell; a section's style; a metadata key), merged by
 * whole-value replacement, never by character. Both sides changing the same
 * unit to different values is a conflict, settled by the policy.
 *
 * With no draft nothing can conflict: the result is the Doc.
 */

export type ConflictPolicy = "manual" | "doc-wins" | "draft-wins" | "fail";
export const CONFLICT_POLICIES: readonly ConflictPolicy[] = ["manual", "doc-wins", "draft-wins", "fail"];

export type Conflict = {
  /** A stable name for the unit, e.g. `node:n_1:text`, `meta:title`, `order:nodes`. */
  unit: string;
  nodeId?: string;
  base: unknown;
  doc: unknown;
  draft: unknown;
  /** Which side's value is in the merged page. `manual` keeps the draft's and leaves the choice open. */
  kept: "doc" | "draft";
  resolution: "policy" | "manual";
};

export type MergeResult = {
  /** False only for the `fail` policy with at least one conflict; `page` is then the Doc unchanged. */
  ok: boolean;
  page: Page;
  conflicts: Conflict[];
  /** Whether a person still has to decide something (`manual` with conflicts). */
  needsReview: boolean;
  /** What merging changes in the draft: `diffPages(draft ?? base, page)`. */
  incoming: PageChange[];
};

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const clone = <T,>(value: T): T => structuredClone(value);

type Ctx = { policy: ConflictPolicy; conflicts: Conflict[]; hasDraft: boolean };

/** Three-way pick of one value. */
function pick<T>(ctx: Ctx, unit: string, base: T, doc: T, draft: T, nodeId?: string): T {
  if (!ctx.hasDraft || same(base, doc)) return ctx.hasDraft ? draft : doc;
  if (same(base, draft) || same(doc, draft)) return doc;
  const kept = ctx.policy === "doc-wins" || ctx.policy === "fail" ? "doc" : "draft";
  ctx.conflicts.push({ unit, ...(nodeId ? { nodeId } : {}), base, doc, draft, kept, resolution: ctx.policy === "manual" ? "manual" : "policy" });
  return kept === "doc" ? doc : draft;
}

/** Keeps `existing` unless a conflict exists whose kept side was "draft"/"doc"; helpers for one-sided deletes. */
function settleDelete(ctx: Ctx, unit: string, nodeId: string | undefined, base: unknown, doc: unknown, draft: unknown, modifiedBy: "doc" | "draft"): boolean {
  // One side deleted, the other changed it: a conflict. Returns true to keep the node.
  const kept = ctx.policy === "doc-wins" || ctx.policy === "fail" ? "doc" : "draft";
  ctx.conflicts.push({ unit, ...(nodeId ? { nodeId } : {}), base, doc, draft, kept, resolution: ctx.policy === "manual" ? "manual" : "policy" });
  // The deleting side is the one whose value is `undefined`; keep the node when the kept side is the modifier.
  return kept === modifiedBy;
}

function proseFields(node: Prose) {
  return { tag: node.tag, text: { text: node.text ?? null, items: node.items ?? null }, image: node.image ?? null };
}

function mergeProse(ctx: Ctx, base: Prose | undefined, doc: Prose, draft: Prose): Prose {
  const id = doc.id;
  const b = base ? proseFields(base) : null;
  const d = proseFields(doc);
  const l = proseFields(draft);
  const tag = pick(ctx, `node:${id}:tag`, b?.tag ?? null, d.tag, l.tag, id);
  const text = pick(ctx, `node:${id}:text`, b?.text ?? null, d.text, l.text, id);
  const image = pick(ctx, `node:${id}:image`, b?.image ?? null, d.image, l.image, id);
  const out: Prose = { kind: "prose", id, tag: tag as Prose["tag"] };
  if (text?.text !== null && text?.text !== undefined) out.text = text.text;
  if (text?.items) out.items = [...text.items];
  if (image) out.image = { ...image };
  return out;
}

function mergeBlock(ctx: Ctx, base: Block | undefined, doc: Block, draft: Block): Block {
  const id = doc.id;
  const name = pick(ctx, `node:${id}:name`, base?.name ?? null, doc.name, draft.name, id) as string;
  const options = pick(ctx, `node:${id}:options`, base?.options ?? null, doc.options, draft.options, id) as string[];
  const shape = (block: Block | undefined) => (block ? block.rows.map((row) => row.length) : null);
  const merged = pick(ctx, `node:${id}:shape`, shape(base), shape(doc), shape(draft), id) as number[];
  const rows: Cell[][] = merged.map((cols, row) =>
    Array.from({ length: cols }, (_, col): Cell => {
      const bc = base?.rows[row]?.[col]?.children ?? null;
      const dc = doc.rows[row]?.[col]?.children ?? [];
      const lc = draft.rows[row]?.[col]?.children ?? [];
      const children = pick(ctx, `node:${id}:cell:${row}:${col}`, bc, dc, lc, id);
      return { id: doc.rows[row]?.[col]?.id ?? draft.rows[row]?.[col]?.id ?? `c_${id}_${row}_${col}`, children: clone(children ?? []) };
    }),
  );
  return { kind: "block", id, name, options: [...options], rows };
}

function mergeNode(ctx: Ctx, base: Node | undefined, doc: Node, draft: Node): Node {
  if (doc.kind !== draft.kind || (base && base.kind !== doc.kind)) {
    // The node changed kind on a side: replace it whole.
    return clone(pick(ctx, `node:${doc.id}`, base ?? null, doc, draft, doc.id) ?? doc);
  }
  if (doc.kind === "prose") return mergeProse(ctx, base as Prose | undefined, doc, draft as Prose);
  return mergeBlock(ctx, base as Block | undefined, doc, draft as Block);
}

/** Merges three id sequences. `keep` is the set of ids that survive. Deterministic. */
function mergeOrder(ctx: Ctx, unit: string, base: string[], doc: string[], draft: string[], keep: Set<string>): string[] {
  const inAll = new Set(base.filter((id) => doc.includes(id) && draft.includes(id) && keep.has(id)));
  const restrict = (list: string[]) => list.filter((id) => inAll.has(id));
  const b = restrict(base);
  const d = restrict(doc);
  const l = restrict(draft);
  let skeleton: string[];
  if (same(d, b)) skeleton = l;
  else if (same(l, b) || same(d, l)) skeleton = d;
  else {
    const kept = ctx.policy === "doc-wins" || ctx.policy === "fail" ? "doc" : "draft";
    ctx.conflicts.push({ unit, base: b, doc: d, draft: l, kept, resolution: ctx.policy === "manual" ? "manual" : "policy" });
    skeleton = kept === "doc" ? d : l;
  }
  const out = [...skeleton];
  const present = new Set(out);
  // Everything else that survives (added on a side, or kept through a conflict) goes after the
  // nearest earlier neighbour it had in its own list. The draft's additions go first, then the Doc's.
  for (const list of [draft, doc]) {
    list.forEach((id, index) => {
      if (!keep.has(id) || present.has(id)) return;
      let at = 0;
      for (let i = index - 1; i >= 0; i--) {
        const found = out.indexOf(list[i]!);
        if (found !== -1) {
          at = found + 1;
          break;
        }
      }
      out.splice(at, 0, id);
      present.add(id);
    });
  }
  return out;
}

const flat = (page: Page) => page.sections.flatMap((section) => section.children);
const sectionOf = (page: Page) => new Map(page.sections.flatMap((section) => section.children.map((node) => [node.id, section.id] as const)));

export function mergePages(base: Page, doc: Page, draft: Page | null, policy: ConflictPolicy = draft ? "manual" : "doc-wins"): MergeResult {
  const ctx: Ctx = { policy, conflicts: [], hasDraft: draft !== null };
  if (!draft) return { ok: true, page: clone(doc), conflicts: [], needsReview: false, incoming: diffPages(base, doc) };

  // Metadata, key by key.
  const metadata: Record<string, string> = {};
  const keys = [...new Set([...Object.keys(base.metadata), ...Object.keys(doc.metadata), ...Object.keys(draft.metadata)])].sort();
  for (const key of keys) {
    const value = pick<string | null>(ctx, `meta:${key}`, base.metadata[key] ?? null, doc.metadata[key] ?? null, draft.metadata[key] ?? null);
    if (value !== null) metadata[key] = value;
  }

  // Sections: existence, style and order.
  const bs = new Map(base.sections.map((s) => [s.id, s]));
  const ds = new Map(doc.sections.map((s) => [s.id, s]));
  const ls = new Map(draft.sections.map((s) => [s.id, s]));
  const sectionIds = [...new Set([...base.sections, ...doc.sections, ...draft.sections].map((s) => s.id))];
  const sections = new Map<string, Section>();
  for (const id of sectionIds) {
    const b = bs.get(id);
    const d = ds.get(id);
    const l = ls.get(id);
    let keep: Section | undefined;
    if (d && l) keep = { id, style: pick(ctx, `section:${id}:style`, b?.style ?? null, d.style, l.style) as string[], children: [] };
    else if (!b) keep = { id, style: [...(d ?? l)!.style], children: [] };
    else if (!d && !l) keep = undefined;
    else {
      // Removed on one side. A conflict only if the other side changed the section's style or nodes.
      const survivor = (d ?? l)!;
      const changed = !same(b.style, survivor.style) || !same(b.children.map((n) => n.id), survivor.children.map((n) => n.id));
      const modifiedBy = d ? "doc" : "draft";
      keep = changed && settleDelete(ctx, `section:${id}`, undefined, b, d ?? null, l ?? null, modifiedBy) ? { id, style: [...survivor.style], children: [] } : undefined;
    }
    if (keep) sections.set(id, keep);
  }
  const sectionOrder = mergeOrder(ctx, "order:sections", base.sections.map((s) => s.id), doc.sections.map((s) => s.id), draft.sections.map((s) => s.id), new Set(sections.keys()));

  // Nodes: existence and content, then which section, then order.
  const bn = new Map(flat(base).map((n) => [n.id, n]));
  const dn = new Map(flat(doc).map((n) => [n.id, n]));
  const ln = new Map(flat(draft).map((n) => [n.id, n]));
  const nodeIds = [...new Set([...bn.keys(), ...dn.keys(), ...ln.keys()])];
  const nodes = new Map<string, Node>();
  for (const id of nodeIds) {
    const b = bn.get(id);
    const d = dn.get(id);
    const l = ln.get(id);
    if (d && l) nodes.set(id, mergeNode(ctx, b, d, l));
    else if (!b) nodes.set(id, clone((d ?? l)!));
    else if (!d && !l) continue;
    else {
      const survivor = (d ?? l)!;
      if (same(b, survivor)) continue; // one side deleted what the other left alone
      if (settleDelete(ctx, `node:${id}`, id, b, d ?? null, l ?? null, d ? "doc" : "draft")) nodes.set(id, clone(survivor));
    }
  }
  const placeBase = sectionOf(base);
  const placeDoc = sectionOf(doc);
  const placeDraft = sectionOf(draft);
  const flatOrder = mergeOrder(ctx, "order:nodes", flat(base).map((n) => n.id), flat(doc).map((n) => n.id), flat(draft).map((n) => n.id), new Set(nodes.keys()));
  const fallback = sectionOrder[0] ?? null;
  const result: Section[] = sectionOrder.map((id) => sections.get(id)!);
  if (result.length === 0 && nodes.size > 0) result.push({ id: doc.sections[0]?.id ?? "s_merged", style: [], children: [] });
  const byId = new Map(result.map((section) => [section.id, section]));
  for (const id of flatOrder) {
    const placed = pick<string | null>(ctx, `node:${id}:section`, placeBase.get(id) ?? null, placeDoc.get(id) ?? null, placeDraft.get(id) ?? null, id);
    const target = (placed && byId.get(placed)) || byId.get(fallback ?? "") || result[0]!;
    target.children.push(nodes.get(id)!);
  }

  const page: Page = { fileId: doc.fileId, revisionId: doc.revisionId, path: doc.path, metadata, sections: result };
  if (policy === "fail" && ctx.conflicts.length > 0) {
    return { ok: false, page: clone(doc), conflicts: ctx.conflicts, needsReview: false, incoming: [] };
  }
  return {
    ok: true,
    page,
    conflicts: ctx.conflicts,
    needsReview: ctx.conflicts.some((c) => c.resolution === "manual"),
    incoming: diffPages(draft, page),
  };
}
