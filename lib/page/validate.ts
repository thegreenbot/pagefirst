/**
 * Runtime schema for commit requests. The commit route, and later the REST API
 * and MCP tools, validate untrusted input here before it reaches `applyOps` or
 * Google, so the contract in `types.ts` has one enforced shape.
 */
import { PRESENTATION_KEYS } from "./parse";
import { isSafeId, type Block, type Cell, type Op, type Prose, type ProseTag } from "./types";

export const LIMITS = {
  /** Whole request body, checked before parsing. */
  maxBodyBytes: 512 * 1024,
  maxOps: 200,
  maxTextLength: 20_000,
  maxListItems: 200,
  maxOptions: 20,
  maxRows: 50,
  maxCellsPerRow: 12,
  maxCellChildren: 50,
  maxIndex: 10_000,
  maxAltLength: 500,
  maxMetadataValueLength: 2_000,
  maxRevisionIdLength: 200,
} as const;

export const PROSE_TAGS: readonly ProseTag[] = ["h1", "h2", "h3", "h4", "p", "ul", "ol", "img"];

/** Blocks the editor can insert. Blocks already in a Doc may have other names. */
export const INSERTABLE_BLOCKS: readonly string[] = ["hero", "columns", "cards"];

/** Options come from Doc labels like "columns (contained, dark)": no delimiters or control characters. */
const OPTION = /^[^(),\u0000-\u001f]{1,40}$/;
const METADATA_KEY = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;

export type CommitRequest = { baseRevisionId: string; ops: Op[] };

export type ValidationResult =
  | { ok: true; value: CommitRequest }
  | { ok: false; path: string; error: string };

class Invalid extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
  }
}

type Obj = Record<string, unknown>;

function object(value: unknown, path: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Invalid(path, "must be an object");
  }
  return value as Obj;
}

function onlyKeys(value: Obj, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Invalid(path ? `${path}.${key}` : key, "is not allowed");
  }
}

function string(value: unknown, path: string, max: number): string {
  if (typeof value !== "string") throw new Invalid(path, "must be a string");
  if (value.length > max) throw new Invalid(path, `must be at most ${max} characters`);
  return value;
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || !isSafeId(value)) {
    throw new Invalid(path, "must be an id of letters, digits, _ or -");
  }
  return value;
}

function index(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > LIMITS.maxIndex) {
    throw new Invalid(path, `must be a whole number from 0 to ${LIMITS.maxIndex}`);
  }
  return value;
}

function array(value: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new Invalid(path, "must be an array");
  if (value.length > max) throw new Invalid(path, `must have at most ${max} entries`);
  return value;
}

function tag(value: unknown, path: string): ProseTag {
  if (typeof value !== "string" || !(PROSE_TAGS as readonly string[]).includes(value)) {
    throw new Invalid(path, `must be one of ${PROSE_TAGS.join(", ")}`);
  }
  return value as ProseTag;
}

function options(value: unknown, path: string): string[] {
  return array(value, path, LIMITS.maxOptions).map((option, i) => {
    if (typeof option !== "string" || !OPTION.test(option)) {
      throw new Invalid(`${path}[${i}]`, "must be 1 to 40 characters without parentheses, commas or control characters");
    }
    return option;
  });
}

function image(value: unknown, path: string): { driveFileId: string; alt: string } {
  const raw = object(value, path);
  onlyKeys(raw, path, ["driveFileId", "alt"]);
  return {
    driveFileId: id(raw.driveFileId, `${path}.driveFileId`),
    alt: string(raw.alt, `${path}.alt`, LIMITS.maxAltLength),
  };
}

function prose(value: unknown, path: string): Prose {
  const raw = object(value, path);
  onlyKeys(raw, path, ["kind", "id", "tag", "text", "items", "image"]);
  if (raw.kind !== "prose") throw new Invalid(`${path}.kind`, 'must be "prose"');
  const node: Prose = { kind: "prose", id: id(raw.id, `${path}.id`), tag: tag(raw.tag, `${path}.tag`) };
  if (raw.text !== undefined) node.text = string(raw.text, `${path}.text`, LIMITS.maxTextLength);
  if (raw.items !== undefined) {
    node.items = array(raw.items, `${path}.items`, LIMITS.maxListItems).map((item, i) =>
      string(item, `${path}.items[${i}]`, LIMITS.maxTextLength),
    );
  }
  if (raw.image !== undefined) node.image = image(raw.image, `${path}.image`);
  return node;
}

function cell(value: unknown, path: string): Cell {
  const raw = object(value, path);
  onlyKeys(raw, path, ["id", "children"]);
  return {
    id: id(raw.id, `${path}.id`),
    children: array(raw.children, `${path}.children`, LIMITS.maxCellChildren).map((child, i) =>
      prose(child, `${path}.children[${i}]`),
    ),
  };
}

function block(value: unknown, path: string): Block {
  const raw = object(value, path);
  onlyKeys(raw, path, ["kind", "id", "name", "options", "rows"]);
  if (raw.kind !== "block") throw new Invalid(`${path}.kind`, 'must be "block"');
  if (typeof raw.name !== "string" || !INSERTABLE_BLOCKS.includes(raw.name)) {
    throw new Invalid(`${path}.name`, `must be one of ${INSERTABLE_BLOCKS.join(", ")}`);
  }
  return {
    kind: "block",
    id: id(raw.id, `${path}.id`),
    name: raw.name,
    options: options(raw.options, `${path}.options`),
    rows: array(raw.rows, `${path}.rows`, LIMITS.maxRows).map((row, r) =>
      array(row, `${path}.rows[${r}]`, LIMITS.maxCellsPerRow).map((c, i) => cell(c, `${path}.rows[${r}][${i}]`)),
    ),
  };
}

function op(value: unknown, path: string): Op {
  const raw = object(value, path);
  const at = (key: string) => `${path}.${key}`;
  switch (raw.op) {
    case "replaceText":
      onlyKeys(raw, path, ["op", "nodeId", "text"]);
      return { op: "replaceText", nodeId: id(raw.nodeId, at("nodeId")), text: string(raw.text, at("text"), LIMITS.maxTextLength) };
    case "setTag":
      onlyKeys(raw, path, ["op", "nodeId", "tag"]);
      return { op: "setTag", nodeId: id(raw.nodeId, at("nodeId")), tag: tag(raw.tag, at("tag")) };
    case "setBlockOptions":
      onlyKeys(raw, path, ["op", "nodeId", "options"]);
      return { op: "setBlockOptions", nodeId: id(raw.nodeId, at("nodeId")), options: options(raw.options, at("options")) };
    case "setMetadata": {
      onlyKeys(raw, path, ["op", "key", "value"]);
      if (typeof raw.key !== "string" || !METADATA_KEY.test(raw.key)) {
        throw new Invalid(at("key"), "must be a metadata key of letters, digits, spaces, _ or -");
      }
      if (PRESENTATION_KEYS.has(raw.key.toLowerCase())) {
        throw new Invalid(at("key"), "is set in the editor's theme settings, not in the Doc");
      }
      return { op: "setMetadata", key: raw.key, value: string(raw.value, at("value"), LIMITS.maxMetadataValueLength) };
    }
    case "insertBlock":
      onlyKeys(raw, path, ["op", "sectionId", "index", "block"]);
      return {
        op: "insertBlock",
        sectionId: id(raw.sectionId, at("sectionId")),
        index: index(raw.index, at("index")),
        block: block(raw.block, at("block")),
      };
    case "insertProse":
      onlyKeys(raw, path, ["op", "sectionId", "index", "node"]);
      return {
        op: "insertProse",
        sectionId: id(raw.sectionId, at("sectionId")),
        index: index(raw.index, at("index")),
        node: prose(raw.node, at("node")),
      };
    case "insertSection":
      onlyKeys(raw, path, ["op", "index"]);
      return { op: "insertSection", index: index(raw.index, at("index")) };
    case "removeNode":
      onlyKeys(raw, path, ["op", "nodeId"]);
      return { op: "removeNode", nodeId: id(raw.nodeId, at("nodeId")) };
    case "moveNode":
      onlyKeys(raw, path, ["op", "nodeId", "toSectionId", "index"]);
      return {
        op: "moveNode",
        nodeId: id(raw.nodeId, at("nodeId")),
        toSectionId: id(raw.toSectionId, at("toSectionId")),
        index: index(raw.index, at("index")),
      };
    case "setImage":
      onlyKeys(raw, path, ["op", "nodeId", "driveFileId", "alt"]);
      return {
        op: "setImage",
        nodeId: id(raw.nodeId, at("nodeId")),
        driveFileId: id(raw.driveFileId, at("driveFileId")),
        alt: string(raw.alt, at("alt"), LIMITS.maxAltLength),
      };
    default:
      throw new Invalid(at("op"), "is not a known op");
  }
}

/** Validates a parsed commit body. Unknown fields are refused so typos never pass silently. */
export function validateCommitRequest(body: unknown): ValidationResult {
  try {
    const raw = object(body, "");
    onlyKeys(raw, "", ["baseRevisionId", "ops"]);
    const baseRevisionId = string(raw.baseRevisionId, "baseRevisionId", LIMITS.maxRevisionIdLength);
    const ops = array(raw.ops, "ops", LIMITS.maxOps).map((entry, i) => op(entry, `ops[${i}]`));
    return { ok: true, value: { baseRevisionId, ops } };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, path: error.path || "body", error: error.message };
    throw error;
  }
}
