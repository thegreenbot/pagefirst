import { duplicateIds, namedRangeSpecs, parseDocument } from "@/lib/page/parse";
import { isSafeId, type DocsDocument, type Page } from "@/lib/page/types";

/**
 * The adopt step of an import (#32, docs/adr/0006-import-model.md): give every
 * node in a Doc a named range, so it can be diffed, merged and edited later.
 * It only adds or removes named ranges, which change nothing a reader sees.
 *
 *  - Content typed or pasted in Docs has no range: a new id is minted.
 *  - A range an editor deleted leaves its node untracked: same, new id.
 *  - A range that now covers two paragraphs (a merge in Docs) matches neither: its id
 *    is re-anchored to the first paragraph it covers, so a later diff sees an edit and
 *    not a removal plus an addition; the other gets a new id.
 *  - A range copied with its text now marks two nodes: the first keeps the id, the
 *    copies get new ones.
 *
 * Pure: it returns the Docs requests and a report, and a Doc that is already
 * fully tracked yields no requests, so a second import writes nothing.
 */

export type AdoptReport = {
  /** Named ranges created for nodes that had none (including re-created ones). */
  adopted: number;
  /** Ids a copy/paste had given to several nodes; the extra copies were given new ids. */
  duplicated: { id: string; copies: number }[];
  /** Named ranges that matched no node and were removed. */
  orphans: string[];
  /** Orphaned ids given back to the first untracked node their range covered. */
  reanchored: string[];
};

const NODE = "pg/node/";
const SECTION = "pg/section/";

function usedIds(page: Page): Set<string> {
  const ids = new Set<string>();
  for (const section of page.sections) {
    ids.add(section.id);
    for (const node of section.children) {
      ids.add(node.id);
      if (node.kind === "block") for (const row of node.rows) for (const cell of row) for (const child of cell.children) ids.add(child.id);
    }
  }
  return ids;
}

export function planAdopt(doc: DocsDocument): { requests: object[]; report: AdoptReport } {
  const page = parseDocument(doc);
  const used = usedIds(page);
  const dups = duplicateIds(doc);

  const names = new Set<string>();
  for (const [key, value] of Object.entries(doc.namedRanges ?? {})) names.add(value.name ?? key);

  const deletes: string[] = [];
  const duplicated: AdoptReport["duplicated"] = [];
  for (const [id, copies] of Object.entries(dups)) {
    // The first claimant keeps the id: drop the shared range and recreate it below, per node.
    for (const prefix of [NODE, SECTION]) {
      if (names.delete(prefix + id)) deletes.push(prefix + id);
    }
    duplicated.push({ id, copies });
  }

  const orphans: string[] = [];
  for (const name of [...names]) {
    const prefix = name.startsWith(NODE) ? NODE : name.startsWith(SECTION) ? SECTION : null;
    if (!prefix) continue;
    const id = name.slice(prefix.length);
    if (isSafeId(id) && used.has(id)) continue;
    // A node-less range: deleted content, a range split across paragraphs, or an id we cannot use.
    names.delete(name);
    orphans.push(name);
    deletes.push(name);
  }

  const specs = namedRangeSpecs(doc);
  // Give an orphaned id to the first untracked node its old range overlapped.
  const rename = new Map<string, string>();
  const reanchored: string[] = [];
  for (const name of orphans) {
    if (!name.startsWith(NODE) || !isSafeId(name.slice(NODE.length))) continue;
    const ranges = (doc.namedRanges ?? {})[name]?.namedRanges?.flatMap((group) => group.ranges ?? []) ?? [];
    const target = specs.find(
      (spec) =>
        spec.name.startsWith(NODE) &&
        !names.has(spec.name) &&
        !rename.has(spec.name) &&
        ranges.some((range) => typeof range.startIndex === "number" && typeof range.endIndex === "number" && range.startIndex < spec.endIndex && spec.startIndex < range.endIndex),
    );
    if (!target) continue;
    rename.set(target.name, name);
    reanchored.push(name);
  }

  const creates: object[] = [];
  const created = new Set<string>();
  for (const original of specs) {
    const spec = { ...original, name: rename.get(original.name) ?? original.name };
    if (names.has(spec.name)) continue;
    created.add(spec.name);
    creates.push({ createNamedRange: { name: spec.name, range: { startIndex: spec.startIndex, endIndex: spec.endIndex } } });
  }

  return {
    requests: [...deletes.map((name) => ({ deleteNamedRange: { name } })), ...creates],
    report: { adopted: created.size, duplicated, orphans, reanchored },
  };
}
