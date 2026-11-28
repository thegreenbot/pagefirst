import { applyOps } from "@/lib/page/ops";
import type { Op, Page } from "@/lib/page/types";

/** Which unit of the page an op edits, in the names the merge engine uses for conflicts. */
export function unitsOfOp(op: Op): string[] {
  switch (op.op) {
    case "replaceText":
      return [`node:${op.nodeId}:text`];
    case "setTag":
      return [`node:${op.nodeId}:tag`];
    case "setBlockOptions":
      return [`node:${op.nodeId}:options`];
    case "setImage":
      return [`node:${op.nodeId}:image`];
    case "setMetadata":
      return [`meta:${op.key}`];
    case "removeNode":
    case "moveNode":
      return [`node:${op.nodeId}`];
    default:
      return [];
  }
}

export type Rebased = {
  page: Page;
  /** Ops that still apply on top of the new Doc, in order. */
  kept: Op[];
  /** Ops left out: the author chose the Doc's version, or the Doc removed what they edited. */
  dropped: Op[];
};

/**
 * Re-applies the editor's uncommitted ops onto the Doc as just imported. An op is
 * dropped when the author chose the Doc's side of a conflict it belongs to, or when
 * it no longer applies (the Doc removed the node). Everything else is kept, so an
 * unrelated draft survives an import.
 */
export function rebaseOps(docPage: Page, ops: Op[], keepDoc: ReadonlySet<string>): Rebased {
  let page = structuredClone(docPage);
  const kept: Op[] = [];
  const dropped: Op[] = [];
  for (const op of ops) {
    if (unitsOfOp(op).some((unit) => keepDoc.has(unit) || [...keepDoc].some((chosen) => unit.startsWith(`${chosen}:`)))) {
      dropped.push(op);
      continue;
    }
    try {
      page = applyOps(page, [op]);
      kept.push(op);
    } catch {
      dropped.push(op);
    }
  }
  return { page: { ...page, revisionId: docPage.revisionId }, kept, dropped };
}
