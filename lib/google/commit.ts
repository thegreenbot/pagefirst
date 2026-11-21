import { namedRangeSpecs } from "@/lib/page/parse";
import type { DocsDocument, DocsStructuralElement, Op } from "@/lib/page/types";

type Span = { startIndex: number; endIndex: number };

/**
 * Named ranges include the paragraph's trailing newline. Delete everything
 * before that newline, then insert the replacement at the same index.
 */
function replaceSpan(startIndex: number, endIndex: number, text: string): object[] {
  const requests: object[] = [];
  if (endIndex > startIndex + 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex, endIndex: endIndex - 1 },
      },
    });
  }
  requests.push({
    insertText: {
      text,
      location: { index: startIndex },
    },
  });
  return requests;
}

function findNodeSpan(doc: DocsDocument, nodeId: string): Span {
  const wanted = `pg/node/${nodeId}`;
  for (const [key, group] of Object.entries(doc.namedRanges ?? {})) {
    if (key !== wanted && group?.name !== wanted) continue;
    for (const named of group?.namedRanges ?? []) {
      const range = named.ranges?.[0];
      if (range?.startIndex != null && range.endIndex != null && range.endIndex > range.startIndex) {
        return { startIndex: range.startIndex, endIndex: range.endIndex };
      }
    }
  }
  throw new Error(`Missing named range for ${nodeId}`);
}

function textOf(content: DocsStructuralElement[] | undefined): string {
  let text = "";
  for (const el of content ?? []) {
    for (const run of el.paragraph?.elements ?? []) {
      text += run.textRun?.content ?? "";
    }
  }
  return text;
}

function paragraphSpan(content: DocsStructuralElement[] | undefined): Span | null {
  for (const el of content ?? []) {
    if (el.paragraph && el.startIndex != null && el.endIndex != null && el.endIndex > el.startIndex) {
      return { startIndex: el.startIndex, endIndex: el.endIndex };
    }
  }
  return null;
}

function tablesIn(content: DocsStructuralElement[] | undefined): NonNullable<DocsStructuralElement["table"]>[] {
  const tables: NonNullable<DocsStructuralElement["table"]>[] = [];
  for (const el of content ?? []) {
    if (!el.table) continue;
    tables.push(el.table);
    for (const row of el.table.rows ?? []) {
      for (const cell of row.tableCells ?? []) {
        tables.push(...tablesIn(cell.content));
      }
    }
  }
  return tables;
}

function findMetadataSpan(doc: DocsDocument, key: string): Span {
  for (const table of tablesIn(doc.body?.content)) {
    const rows = table.rows ?? [];
    const header = textOf(rows[0]?.tableCells?.[0]?.content).replace(/\s+/g, " ").trim().toLowerCase();
    if (header !== "metadata") continue;
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i]?.tableCells ?? [];
      if (textOf(cells[0]?.content).trim() !== key) continue;
      const span = paragraphSpan(cells[1]?.content);
      if (!span) throw new Error(`Metadata key not found: ${key}`);
      return span;
    }
  }
  throw new Error(`Metadata key not found: ${key}`);
}

export function buildCommitRequests(doc: DocsDocument, ops: Op[]): { requests: object[] } {
  for (const op of ops) {
    if (op.op !== "replaceText" && op.op !== "setMetadata") {
      throw new Error(`Live commit does not support ${op.op}`);
    }
    if (op.op === "setMetadata" && op.value === "") {
      throw new Error("Live commit cannot delete metadata keys");
    }
  }

  const groups: { index: number; requests: object[] }[] = [];
  for (const op of ops) {
    if (op.op === "replaceText") {
      const span = findNodeSpan(doc, op.nodeId);
      groups.push({
        index: span.startIndex,
        requests: replaceSpan(span.startIndex, span.endIndex, op.text),
      });
      continue;
    }
    if (op.op !== "setMetadata") continue;
    const span = findMetadataSpan(doc, op.key);
    groups.push({
      index: span.startIndex,
      requests: replaceSpan(span.startIndex, span.endIndex, op.value),
    });
  }

  groups.sort((a, b) => b.index - a.index);
  return { requests: groups.flatMap((group) => group.requests) };
}

function specSpan(spec: unknown): { name: string; startIndex?: number; endIndex?: number } {
  if (!spec || typeof spec !== "object") return { name: "" };
  const record = spec as {
    name?: unknown;
    startIndex?: unknown;
    endIndex?: unknown;
    range?: { startIndex?: unknown; endIndex?: unknown };
  };
  const startIndex = typeof record.startIndex === "number" ? record.startIndex : record.range?.startIndex;
  const endIndex = typeof record.endIndex === "number" ? record.endIndex : record.range?.endIndex;
  return {
    name: typeof record.name === "string" ? record.name : "",
    startIndex: typeof startIndex === "number" ? startIndex : undefined,
    endIndex: typeof endIndex === "number" ? endIndex : undefined,
  };
}

export function buildAdoptRequests(doc: DocsDocument): { requests: object[] } {
  const existing = new Set(Object.keys(doc.namedRanges ?? {}));
  const requests: object[] = [];
  for (const spec of namedRangeSpecs(doc)) {
    const { name, startIndex, endIndex } = specSpan(spec);
    if (!name || existing.has(name)) continue;
    if (startIndex == null || endIndex == null) continue;
    requests.push({
      createNamedRange: {
        name,
        range: { startIndex, endIndex },
      },
    });
  }
  return { requests };
}
