import { createId, isSafeId } from "./types";
import type {
  Block,
  Cell,
  DocsDocument,
  DocsStructuralElement,
  Page,
  Prose,
  ProseTag,
  Section,
} from "./types";

type Spec = { name: string; startIndex: number; endIndex: number };

type Walked = {
  metadata: Record<string, string>;
  sections: Section[];
  specs: Spec[];
};

const walkCache = new WeakMap<DocsDocument, Walked>();

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolvePath(doc: DocsDocument, path?: string): string {
  if (path) return path;
  if (doc.title) {
    const slugged = slug(doc.title);
    if (slugged) return slugged;
  }
  return "index";
}

function paragraphText(el: DocsStructuralElement): string {
  let text = "";
  for (const part of el.paragraph?.elements ?? []) {
    if (part.textRun?.content) text += part.textRun.content;
  }
  return text;
}

function structuralText(elements: DocsStructuralElement[] | undefined): string {
  if (!elements) return "";
  let text = "";
  for (const el of elements) text += paragraphText(el);
  return text;
}

function visibleText(el: DocsStructuralElement): string {
  const raw = paragraphText(el);
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function hasInlineImage(el: DocsStructuralElement): boolean {
  return !!el.paragraph?.elements?.some((part) => part.inlineObjectElement);
}

function isEmptyStructural(el: DocsStructuralElement): boolean {
  if (el.table) return (el.table.rows ?? []).length === 0;
  if (!el.paragraph) return true;
  if (el.paragraph.bullet) return false;
  if (hasInlineImage(el)) return false;
  return visibleText(el).length === 0;
}

function isSectionBreak(el: DocsStructuralElement): boolean {
  return paragraphText(el).trim() === "---";
}

function tableLabel(el: DocsStructuralElement): string {
  const content = el.table?.rows?.[0]?.tableCells?.[0]?.content;
  return structuralText(content).replace(/\s+/g, " ").trim().toLowerCase();
}

function headingTag(style: string | undefined): ProseTag {
  switch (style) {
    case "HEADING_1":
      return "h1";
    case "HEADING_2":
      return "h2";
    case "HEADING_3":
      return "h3";
    case "HEADING_4":
      return "h4";
    default:
      return "p";
  }
}

function pushSpec(
  specs: Spec[],
  name: string,
  el: { startIndex?: number; endIndex?: number },
): void {
  if (typeof el.startIndex !== "number" || typeof el.endIndex !== "number") return;
  specs.push({ name, startIndex: el.startIndex, endIndex: el.endIndex });
}

function rangeMatches(
  elStart: number,
  elEnd: number,
  rangeStart: number,
  rangeEnd: number,
): boolean {
  const overlaps = rangeStart < elEnd && elStart < rangeEnd;
  if (!overlaps) return false;
  return Math.abs(rangeStart - elStart) <= 1 && Math.abs(rangeEnd - elEnd) <= 1;
}

function namedId(
  doc: DocsDocument,
  elements: DocsStructuralElement[],
  prefix: "pg/node/" | "pg/section/",
): string | undefined {
  let best: { id: string; score: number } | undefined;
  const namedRanges = doc.namedRanges ?? {};
  for (const el of elements) {
    if (typeof el.startIndex !== "number" || typeof el.endIndex !== "number") continue;
    for (const [key, value] of Object.entries(namedRanges)) {
      const name = value.name ?? key;
      if (!name.startsWith(prefix)) continue;
      const id = name.slice(prefix.length);
      if (!isSafeId(id)) continue;
      for (const named of value.namedRanges ?? []) {
        for (const range of named.ranges ?? []) {
          if (typeof range.startIndex !== "number" || typeof range.endIndex !== "number") continue;
          if (!rangeMatches(el.startIndex, el.endIndex, range.startIndex, range.endIndex)) continue;
          const score =
            Math.abs(range.startIndex - el.startIndex) + Math.abs(range.endIndex - el.endIndex);
          if (!best || score < best.score) best = { id, score };
        }
      }
    }
  }
  return best?.id;
}

function nodeId(doc: DocsDocument, elements: DocsStructuralElement[]): string {
  return namedId(doc, elements, "pg/node/") ?? createId("n");
}

function sectionBreakId(doc: DocsDocument, el: DocsStructuralElement): string {
  return namedId(doc, [el], "pg/section/") ?? createId("s");
}

function glyphIsNumbered(bullet: { listId?: string }): boolean {
  const extra = bullet as { glyph?: unknown; glyphType?: unknown; glyphSymbol?: unknown };
  const glyph = [extra.glyph, extra.glyphType, extra.glyphSymbol]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (!glyph) return false;
  if (/[0-9]/.test(glyph)) return true;
  return /(decimal|digit|number|alpha|roman|latin)/.test(glyph);
}

function listIsOrdered(group: DocsStructuralElement[]): boolean {
  return group.some((el) => {
    const bullet = el.paragraph?.bullet;
    if (!bullet) return false;
    if ((bullet.listId ?? "").toLowerCase().includes("ol")) return true;
    return glyphIsNumbered(bullet);
  });
}

function parseParagraph(doc: DocsDocument, el: DocsStructuralElement, specs: Spec[]): Prose {
  const id = nodeId(doc, [el]);
  pushSpec(specs, `pg/node/${id}`, el);
  return {
    kind: "prose",
    id,
    tag: headingTag(el.paragraph?.paragraphStyle?.namedStyleType),
    text: visibleText(el),
  };
}

function parseImage(doc: DocsDocument, el: DocsStructuralElement, specs: Spec[]): Prose {
  const id = nodeId(doc, [el]);
  pushSpec(specs, `pg/node/${id}`, el);
  const part = el.paragraph?.elements?.find((item) => item.inlineObjectElement);
  return {
    kind: "prose",
    id,
    tag: "img",
    image: {
      driveFileId: part?.inlineObjectElement?.inlineObjectId ?? "",
      alt: "",
    },
  };
}

function parseList(doc: DocsDocument, group: DocsStructuralElement[], specs: Spec[]): Prose {
  const id = nodeId(doc, group);
  const items = group.map((el) => {
    pushSpec(specs, `pg/node/${id}`, el);
    return visibleText(el);
  });
  return {
    kind: "prose",
    id,
    tag: listIsOrdered(group) ? "ol" : "ul",
    items,
  };
}

function takeList(
  elements: DocsStructuralElement[],
  start: number,
): { group: DocsStructuralElement[]; next: number } {
  const listId = elements[start]?.paragraph?.bullet?.listId;
  const group = [elements[start]];
  let next = start + 1;
  while (next < elements.length) {
    const candidate = elements[next];
    if (candidate.paragraph?.bullet && candidate.paragraph.bullet.listId === listId) {
      group.push(candidate);
      next += 1;
      continue;
    }
    break;
  }
  return { group, next };
}

function parseProseElements(
  doc: DocsDocument,
  elements: DocsStructuralElement[],
  specs: Spec[],
): Prose[] {
  const nodes: Prose[] = [];
  let index = 0;
  while (index < elements.length) {
    const el = elements[index];
    if (isEmptyStructural(el) || el.table) {
      index += 1;
      continue;
    }
    if (el.paragraph?.bullet) {
      const taken = takeList(elements, index);
      nodes.push(parseList(doc, taken.group, specs));
      index = taken.next;
      continue;
    }
    if (hasInlineImage(el)) {
      nodes.push(parseImage(doc, el, specs));
      index += 1;
      continue;
    }
    if (el.paragraph) {
      nodes.push(parseParagraph(doc, el, specs));
      index += 1;
      continue;
    }
    index += 1;
  }
  return nodes;
}

function splitBlockLabel(label: string): { name: string; options: string[] } {
  const open = label.indexOf("(");
  if (open === -1) return { name: label, options: [] };
  const close = label.indexOf(")", open + 1);
  if (close === -1) return { name: label, options: [] };
  const name = label.slice(0, open).trim();
  const options = label
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return { name, options };
}

function parseBlock(doc: DocsDocument, el: DocsStructuralElement, specs: Spec[]): Block {
  const id = nodeId(doc, [el]);
  pushSpec(specs, `pg/node/${id}`, el);
  const rows = el.table?.rows ?? [];
  const label = structuralText(rows[0]?.tableCells?.[0]?.content).replace(/\s+/g, " ").trim();
  const { name, options } = splitBlockLabel(label);
  const body: Cell[][] = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex].tableCells ?? [];
    body.push(
      cells.map((cell) => ({
        id: createId("c"),
        children: parseProseElements(doc, cell.content ?? [], specs),
      })),
    );
  }
  return { kind: "block", id, name, options, rows: body };
}

/** Metadata keys that used to choose presentation. The app stores those now (#56). */
export const PRESENTATION_KEYS = new Set(["template", "theme"]);

function readMetadata(el: DocsStructuralElement, metadata: Record<string, string>): void {
  const rows = el.table?.rows ?? [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex].tableCells ?? [];
    const key = structuralText(cells[0]?.content).trim();
    // Presentation lives in the app, not the Doc (#56): these rows are ignored.
    if (!key || PRESENTATION_KEYS.has(key.toLowerCase())) continue;
    metadata[key] = structuralText(cells[1]?.content).trim();
  }
}

function readSectionStyle(el: DocsStructuralElement): string[] {
  const style: string[] = [];
  for (const row of el.table?.rows ?? []) {
    const cells = row.tableCells ?? [];
    if (cells.length < 2) continue;
    const text = structuralText(cells[1]?.content).trim();
    if (text) style.push(text);
  }
  return style;
}

function computeWalk(doc: DocsDocument): Walked {
  const metadata: Record<string, string> = {};
  const sections: Section[] = [];
  const specs: Spec[] = [];
  let current: Section = { id: createId("s"), style: [], children: [] };
  const elements = doc.body?.content ?? [];
  let index = 0;
  while (index < elements.length) {
    const el = elements[index];
    if (isEmptyStructural(el)) {
      index += 1;
      continue;
    }
    if (el.table) {
      const label = tableLabel(el);
      if (label === "metadata") {
        readMetadata(el, metadata);
        pushSpec(specs, "pg/meta", el);
      } else if (label === "section metadata") {
        current.style = readSectionStyle(el);
      } else {
        current.children.push(parseBlock(doc, el, specs));
      }
      index += 1;
      continue;
    }
    if (el.paragraph && isSectionBreak(el)) {
      const id = sectionBreakId(doc, el);
      pushSpec(specs, `pg/section/${id}`, el);
      sections.push(current);
      current = { id, style: [], children: [] };
      index += 1;
      continue;
    }
    if (el.paragraph?.bullet) {
      const taken = takeList(elements, index);
      current.children.push(parseList(doc, taken.group, specs));
      index = taken.next;
      continue;
    }
    if (hasInlineImage(el)) {
      current.children.push(parseImage(doc, el, specs));
      index += 1;
      continue;
    }
    if (el.paragraph) {
      current.children.push(parseParagraph(doc, el, specs));
      index += 1;
      continue;
    }
    index += 1;
  }
  sections.push(current);
  if (sections.length === 0) {
    sections.push({ id: createId("s"), style: [], children: [] });
  }
  return { metadata, sections, specs };
}

function walkDocument(doc: DocsDocument): Walked {
  const cached = walkCache.get(doc);
  if (cached) return structuredClone(cached);
  const walked = computeWalk(doc);
  walkCache.set(doc, walked);
  return structuredClone(walked);
}

export function parseDocument(doc: DocsDocument, path?: string): Page {
  const walked = walkDocument(doc);
  return {
    fileId: doc.documentId || "doc",
    revisionId: doc.revisionId || "r1",
    path: resolvePath(doc, path),
    metadata: walked.metadata,
    sections: walked.sections,
  };
}

export function namedRangeSpecs(doc: DocsDocument): Spec[] {
  return walkDocument(doc).specs;
}
