import { createId, nextRevision } from "./types";
import type { Block, Op, Page, Prose, Section } from "./types";

function clampIndex(index: number, length: number): number {
  if (!Number.isFinite(index)) return 0;
  const whole = Math.trunc(index);
  if (whole < 0) return 0;
  if (whole > length) return length;
  return whole;
}

function proseById(page: Page, id: string): Prose {
  for (const section of page.sections) {
    for (const child of section.children) {
      if (child.kind === "prose" && child.id === id) return child;
      if (child.kind === "block") {
        for (const row of child.rows) {
          for (const cell of row) {
            for (const prose of cell.children) {
              if (prose.id === id) return prose;
            }
          }
        }
      }
    }
  }
  throw new Error(`Unknown node ${id}`);
}

function blockById(page: Page, id: string): Block {
  for (const section of page.sections) {
    for (const child of section.children) {
      if (child.kind === "block" && child.id === id) return child;
    }
  }
  throw new Error(`Unknown node ${id}`);
}

function sectionById(page: Page, id: string): Section {
  const section = page.sections.find((item) => item.id === id);
  if (!section) throw new Error(`Unknown node ${id}`);
  return section;
}

function replaceText(page: Page, id: string, text: string): void {
  const prose = proseById(page, id);
  if (prose.tag === "ul" || prose.tag === "ol") {
    prose.items = text === "" ? [] : text.split("\n");
    return;
  }
  prose.text = text;
}

function setTag(page: Page, id: string, tag: Prose["tag"]): void {
  const prose = proseById(page, id);
  const fromList = prose.tag === "ul" || prose.tag === "ol";
  const toList = tag === "ul" || tag === "ol";
  if (fromList && !toList && !prose.text) {
    prose.text = (prose.items ?? []).join("\n");
  }
  prose.tag = tag;
}

function removeNode(page: Page, id: string): void {
  const sectionIndex = page.sections.findIndex((section) => section.id === id);
  if (sectionIndex !== -1) {
    if (page.sections.length === 1) page.sections[0].children = [];
    else page.sections.splice(sectionIndex, 1);
    return;
  }
  for (const section of page.sections) {
    const childIndex = section.children.findIndex((child) => child.id === id);
    if (childIndex !== -1) {
      section.children.splice(childIndex, 1);
      return;
    }
  }
  for (const section of page.sections) {
    for (const child of section.children) {
      if (child.kind !== "block") continue;
      for (const row of child.rows) {
        for (const cell of row) {
          const proseIndex = cell.children.findIndex((prose) => prose.id === id);
          if (proseIndex !== -1) {
            cell.children.splice(proseIndex, 1);
            return;
          }
        }
      }
    }
  }
  throw new Error(`Unknown node ${id}`);
}

function moveNode(page: Page, nodeId: string, toSectionId: string, index: number): void {
  let source: Section | undefined;
  let nodeIndex = -1;
  for (const section of page.sections) {
    const found = section.children.findIndex((child) => child.id === nodeId);
    if (found !== -1) {
      source = section;
      nodeIndex = found;
      break;
    }
  }
  if (!source) throw new Error(`Unknown node ${nodeId}`);
  const destination = sectionById(page, toSectionId);
  const [node] = source.children.splice(nodeIndex, 1);
  destination.children.splice(clampIndex(index, destination.children.length), 0, node);
}

function applyOp(page: Page, op: Op): void {
  switch (op.op) {
    case "replaceText":
      replaceText(page, op.nodeId, op.text);
      return;
    case "setTag":
      setTag(page, op.nodeId, op.tag);
      return;
    case "setBlockOptions": {
      const block = blockById(page, op.nodeId);
      block.options = [...op.options];
      return;
    }
    case "setMetadata":
      if (op.value === "") delete page.metadata[op.key];
      else page.metadata[op.key] = op.value;
      return;
    case "insertBlock": {
      const section = sectionById(page, op.sectionId);
      section.children.splice(
        clampIndex(op.index, section.children.length),
        0,
        structuredClone(op.block),
      );
      return;
    }
    case "insertProse": {
      const section = sectionById(page, op.sectionId);
      section.children.splice(
        clampIndex(op.index, section.children.length),
        0,
        structuredClone(op.node),
      );
      return;
    }
    case "insertSection":
      page.sections.splice(clampIndex(op.index, page.sections.length), 0, {
        id: createId("s"),
        style: [],
        children: [],
      });
      return;
    case "removeNode":
      removeNode(page, op.nodeId);
      return;
    case "moveNode":
      moveNode(page, op.nodeId, op.toSectionId, op.index);
      return;
    case "setImage": {
      const prose = proseById(page, op.nodeId);
      prose.tag = "img";
      prose.image = { driveFileId: op.driveFileId, alt: op.alt };
      return;
    }
    default:
      throw new Error(`Unknown op ${(op as { op: string }).op}`);
  }
}

export function applyOps(page: Page, ops: Op[]): Page {
  const next = structuredClone(page);
  for (const op of ops) applyOp(next, op);
  next.revisionId = nextRevision(page.revisionId);
  return next;
}
