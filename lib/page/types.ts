/** Shared page contract. Implementers import this file and do not edit it. */

export type Page = {
  fileId: string;
  revisionId: string;
  path: string;
  metadata: Record<string, string>;
  sections: Section[];
};

export type Section = {
  id: string;
  style: string[];
  children: Node[];
};

export type Node = Prose | Block;

export type ProseTag = "h1" | "h2" | "h3" | "h4" | "p" | "ul" | "ol" | "img";

export type Prose = {
  kind: "prose";
  id: string;
  tag: ProseTag;
  text?: string;
  items?: string[];
  image?: { driveFileId: string; alt: string };
};

export type Block = {
  kind: "block";
  id: string;
  name: string;
  options: string[];
  rows: Cell[][];
};

export type Cell = {
  id: string;
  children: Prose[];
};

export type Op =
  | { op: "replaceText"; nodeId: string; text: string }
  | { op: "setTag"; nodeId: string; tag: ProseTag }
  | { op: "setBlockOptions"; nodeId: string; options: string[] }
  | { op: "setMetadata"; key: string; value: string }
  | { op: "insertBlock"; sectionId: string; index: number; block: Block }
  | { op: "insertProse"; sectionId: string; index: number; node: Prose }
  | { op: "insertSection"; index: number }
  | { op: "removeNode"; nodeId: string }
  | { op: "moveNode"; nodeId: string; toSectionId: string; index: number }
  | { op: "setImage"; nodeId: string; driveFileId: string; alt: string };

export type DocsRange = { startIndex?: number; endIndex?: number };

export type DocsNamedRange = {
  namedRangeId?: string;
  ranges?: DocsRange[];
};

export type DocsDocument = {
  documentId?: string;
  revisionId?: string;
  title?: string;
  body?: { content?: DocsStructuralElement[] };
  namedRanges?: Record<
    string,
    { name?: string; namedRanges?: DocsNamedRange[] }
  >;
};

export type DocsStructuralElement = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    elements?: {
      textRun?: { content?: string };
      inlineObjectElement?: { inlineObjectId?: string };
    }[];
    paragraphStyle?: { namedStyleType?: string };
    bullet?: { listId?: string };
  };
  table?: {
    rows?: {
      tableCells?: { content?: DocsStructuralElement[] }[];
    }[];
  };
};

export type PageSummary = {
  fileId: string;
  path: string;
  title: string;
  revisionId: string;
  /** Drive's last-modified time, known only for live Docs. */
  modifiedTime?: string;
  /**
   * True when the Doc was edited outside Pagefirst since the last commit,
   * publish or import (#30). Absent when Pagefirst has not touched the Doc yet.
   */
  changed?: boolean;
};

/** A Doc that moved on since Pagefirst last wrote or published it (#30). */
export type ChangedInDoc = {
  /** The revision the last snapshot was taken at. */
  baseRevisionId: string;
  /** When the Doc was last modified in Drive, and by whom, when Drive says. */
  modifiedTime: string | null;
  modifiedBy: string | null;
};

export type Library = {
  sample: boolean;
  pages: PageSummary[];
};

export type PagePayload = {
  page: Page;
  sample: boolean;
  /** Set when the Doc changed outside Pagefirst since its last snapshot. */
  changedInDoc?: ChangedInDoc;
};

export type CommitSuccess = {
  ok: true;
  page: Page;
  sample: boolean;
};

export type CommitFailure = {
  ok: false;
  status: number;
  /** A stable machine-readable code (see ServiceErrorCode in lib/service). */
  code?: string;
  error: string;
  page?: Page;
  /** Set on a quota refusal: seconds until the caller should retry. */
  retryAfterSeconds?: number;
};

export type CommitResult = CommitSuccess | CommitFailure;

export type PublishResult = {
  ok: true;
  sample: boolean;
  previewPath: string;
  url?: string;
};

export function createId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function nextRevision(current: string): string {
  const n = Number(current.replace(/\D/g, "")) || 0;
  return `r${n + 1}`;
}

export function pageTitle(page: Page): string {
  for (const section of page.sections) {
    for (const child of section.children) {
      if (child.kind === "prose" && child.tag === "h1" && child.text) return child.text;
    }
  }
  return page.metadata.title || page.path || "Untitled";
}

export function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,200}$/.test(value);
}
