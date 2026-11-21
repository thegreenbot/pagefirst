"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { applyOps } from "@/lib/page/ops";
import {
  createId,
  type Block,
  type Cell,
  type Op,
  type Page,
  type Prose,
  type ProseTag,
  type Section,
} from "@/lib/page/types";

const buttonClass =
  "border border-rule bg-paper px-3 py-1.5 text-sm text-ink disabled:opacity-50";

const textClass: Record<"h1" | "h2" | "h3" | "h4" | "p", string> = {
  h1: "font-serif text-4xl leading-tight tracking-tight",
  h2: "font-serif text-2xl leading-snug tracking-tight",
  h3: "font-serif text-xl leading-snug",
  h4: "font-serif text-lg leading-snug",
  p: "text-base leading-relaxed",
};

const styleTags: ProseTag[] = ["p", "h1", "h2", "h3", "h4"];

type EditorState = {
  draft: Page;
  basePage: Page;
  savedRevision: string;
  pending: Op[];
};

type Published = {
  previewPath: string;
  url?: string;
};

function createModel(page: Page): EditorState {
  const draft = structuredClone(page);
  return {
    draft,
    basePage: structuredClone(draft),
    savedRevision: draft.revisionId,
    pending: [],
  };
}

function coalesce(pending: Op[], op: Op): Op[] {
  const last = pending[pending.length - 1];
  if (
    op.op === "replaceText" &&
    last?.op === "replaceText" &&
    last.nodeId === op.nodeId
  ) {
    return [...pending.slice(0, -1), op];
  }
  return [...pending, op];
}

function applyEdit(state: EditorState, op: Op): EditorState {
  const draft = applyOps(structuredClone(state.draft), [op]);
  if (!draft?.sections) throw new Error("Edit failed");
  return { ...state, draft, pending: coalesce(state.pending, op) };
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Edit failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPage(value: unknown): Page | null {
  if (!isRecord(value)) return null;
  if (typeof value.fileId !== "string" || typeof value.revisionId !== "string") return null;
  if (typeof value.path !== "string" || !Array.isArray(value.sections)) return null;
  if (!isRecord(value.metadata)) return null;
  return value as Page;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorText(data: unknown, response: Response): string {
  if (isRecord(data) && typeof data.error === "string" && data.error) return data.error;
  if (response.statusText) return response.statusText;
  return "Request failed";
}

function listText(node: Prose): string {
  if (Array.isArray(node.items)) return node.items.join("\n");
  return node.text ?? "";
}

function styleChoices(tag: ProseTag): ProseTag[] {
  if (styleTags.includes(tag)) return styleTags;
  return [tag, ...styleTags];
}

function paragraphNode(): Prose {
  return { kind: "prose", id: createId("p"), tag: "p", text: "" };
}

function proseNode(text: string): Prose {
  return { kind: "prose", id: createId("p"), tag: "p", text };
}

function cellWith(text: string): Cell {
  return { id: createId("cell"), children: [proseNode(text)] };
}

function heroBlock(): Block {
  return {
    kind: "block",
    id: createId("block"),
    name: "hero",
    options: [],
    rows: [[cellWith("New hero")]],
  };
}

function columnsBlock(): Block {
  return {
    kind: "block",
    id: createId("block"),
    name: "columns",
    options: ["contained"],
    rows: [[cellWith("Left"), cellWith("Right")]],
  };
}

function cardsBlock(): Block {
  return {
    kind: "block",
    id: createId("block"),
    name: "cards",
    options: [],
    rows: [[cellWith("Card"), cellWith("Card")]],
  };
}

function findSection(page: Page, sectionId: string): Section | undefined {
  return page.sections.find((section) => section.id === sectionId);
}

export function PageEditor({ initial, sample }: { initial: Page; sample: boolean }) {
  const [model, setModel] = useState(() => createModel(initial));
  const modelRef = useRef(model);
  const [status, setStatus] = useState("");
  const [conflict, setConflict] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const committingRef = useRef(false);
  const publishingRef = useRef(false);
  const [published, setPublished] = useState<Published | null>(null);
  const [publicCopy, setPublicCopy] = useState(false);

  modelRef.current = model;
  const dirty = model.pending.length > 0;
  const { draft } = model;

  function edit(op: Op): boolean {
    const current = modelRef.current;
    try {
      const next = applyEdit(current, op);
      modelRef.current = next;
      setModel(next);
      setStatus("");
      return true;
    } catch (error) {
      setStatus(messageOf(error));
      return false;
    }
  }

  function insertParagraph(sectionId: string) {
    const section = findSection(modelRef.current.draft, sectionId);
    if (!section) return;
    edit({
      op: "insertProse",
      sectionId,
      index: section.children.length,
      node: paragraphNode(),
    });
  }

  function insertNamedBlock(sectionId: string, block: Block) {
    const section = findSection(modelRef.current.draft, sectionId);
    if (!section) return;
    edit({
      op: "insertBlock",
      sectionId,
      index: section.children.length,
      block,
    });
  }

  function moveBlock(sectionId: string, nodeId: string, direction: -1 | 1) {
    const section = findSection(modelRef.current.draft, sectionId);
    if (!section) return;
    const from = section.children.findIndex((node) => node.id === nodeId);
    const index = from + direction;
    if (from < 0 || index < 0 || index >= section.children.length) return;
    edit({ op: "moveNode", nodeId, toSectionId: sectionId, index });
  }

  async function onCommit() {
    const current = modelRef.current;
    if (current.pending.length === 0 || committingRef.current) return;
    committingRef.current = true;
    setCommitting(true);
    try {
      const response = await fetch(`/api/pages/${current.draft.fileId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevisionId: current.savedRevision,
          ops: current.pending,
        }),
      });
      const data = await readJson(response);
      const page = isRecord(data) ? asPage(data.page) : null;
      if (response.status === 200 && isRecord(data) && data.ok === true && page) {
        const next = createModel(page);
        modelRef.current = next;
        setModel(next);
        setConflict(false);
        setStatus("Committed.");
        return;
      }
      if (isRecord(data) && data.ok === false && (data.status === 409 || response.status === 409)) {
        setConflict(true);
        setStatus(errorText(data, response));
        return;
      }
      setConflict(false);
      setStatus(errorText(data, response));
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      committingRef.current = false;
      setCommitting(false);
    }
  }

  async function onReload() {
    const fileId = modelRef.current.draft.fileId;
    try {
      const response = await fetch(`/api/pages/${fileId}`, { cache: "no-store" });
      const data = await readJson(response);
      const page = isRecord(data) ? asPage(data.page) : null;
      if (page) {
        const next = createModel(page);
        modelRef.current = next;
        setModel(next);
        setConflict(false);
        setStatus("");
        return;
      }
      setStatus(errorText(data, response));
    } catch (error) {
      setStatus(messageOf(error));
    }
  }

  async function onPublish() {
    const current = modelRef.current;
    if (current.pending.length > 0 || publishingRef.current) return;
    publishingRef.current = true;
    setPublishing(true);
    try {
      const response = await fetch(`/api/pages/${current.draft.fileId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public: publicCopy }),
      });
      const data = await readJson(response);
      if (
        response.ok &&
        isRecord(data) &&
        data.ok === true &&
        typeof data.previewPath === "string"
      ) {
        setPublished({
          previewPath: data.previewPath,
          url: typeof data.url === "string" ? data.url : undefined,
        });
        setStatus(typeof data.warning === "string" ? data.warning : "");
        return;
      }
      setStatus(errorText(data, response));
    } catch (error) {
      setStatus(messageOf(error));
    } finally {
      publishingRef.current = false;
      setPublishing(false);
    }
  }

  const cloudflare =
    published?.url && published.url.startsWith("https://") ? published.url : null;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="sticky top-0 z-10 border-b border-rule bg-paper">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
          <Link href="/" className="font-serif text-lg tracking-tight text-ink">
            Page-first
          </Link>
          <p className="min-w-0 max-w-full break-all text-sm text-ink-soft">{draft.path}</p>
          {sample ? <span className="text-sm text-green">Sample</span> : null}
          <div className="flex flex-wrap items-start gap-2 sm:ml-auto">
            <button
              type="button"
              className={buttonClass}
              disabled={!dirty || committing}
              onClick={() => {
                void onCommit();
              }}
            >
              Commit
            </button>
            <div className="flex flex-col items-start">
              <button
                type="button"
                className={buttonClass}
                disabled={dirty || publishing}
                onClick={() => {
                  void onPublish();
                }}
              >
                Publish
              </button>
              <label className="flex max-w-[16rem] items-start gap-2 text-xs leading-snug text-ink-soft">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={publicCopy}
                  onChange={(event) => setPublicCopy(event.target.checked)}
                />
                Public copy. Anyone with the Cloudflare link can read it.
              </label>
              {dirty ? (
                <p className="mt-1 max-w-[16rem] text-xs leading-snug text-ink-soft">
                  Commit this draft, then publish.
                </p>
              ) : null}
              {published ? (
                <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <a
                    href={published.previewPath}
                    className="text-green underline underline-offset-2"
                  >
                    Open snapshot
                  </a>
                  {cloudflare ? (
                    <a href={cloudflare} className="text-green underline underline-offset-2">
                      Open on Cloudflare
                    </a>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        </div>
        <div
          className={`mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 ${status || conflict ? "pb-3" : ""}`}
        >
          <p role="status" aria-live="polite" className="text-sm text-ink">
            {status}
          </p>
          {conflict ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                void onReload();
              }}
            >
              Reload
            </button>
          ) : null}
        </div>
      </header>

      <main className="mx-auto max-w-3xl bg-paper px-4 pb-24 pt-4">
        {draft.sections.map((section) => (
          <section key={section.id} className="border-b border-rule py-6">
            {section.children.map((node, index) =>
              node.kind === "prose" ? (
                <ProseEditor key={node.id} node={node} onEdit={edit} onReport={setStatus} />
              ) : (
                <BlockView
                  key={node.id}
                  block={node}
                  index={index}
                  count={section.children.length}
                  onMove={(direction) => moveBlock(section.id, node.id, direction)}
                  onRemove={() => edit({ op: "removeNode", nodeId: node.id })}
                  onEdit={edit}
                  onReport={setStatus}
                />
              ),
            )}
            <div className="mt-6 flex flex-wrap gap-2">
              <button type="button" className={buttonClass} onClick={() => insertParagraph(section.id)}>
                Paragraph
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => insertNamedBlock(section.id, heroBlock())}
              >
                Hero
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => insertNamedBlock(section.id, columnsBlock())}
              >
                Columns
              </button>
              <button
                type="button"
                className={buttonClass}
                onClick={() => insertNamedBlock(section.id, cardsBlock())}
              >
                Cards
              </button>
            </div>
          </section>
        ))}
        <MetadataEditor metadata={draft.metadata} onEdit={edit} />
      </main>
    </div>
  );
}

function BlockView({
  block,
  index,
  count,
  onMove,
  onRemove,
  onEdit,
  onReport,
}: {
  block: Block;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
  onEdit: (op: Op) => boolean;
  onReport: (message: string) => void;
}) {
  const label =
    block.options.length > 0 ? `${block.name} (${block.options.join(", ")})` : block.name;
  return (
    <div className="mt-6 border-t border-rule pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-green">{label}</p>
        <button type="button" className={buttonClass} onClick={() => onMove(-1)} disabled={index === 0}>
          Move up
        </button>
        <button
          type="button"
          className={buttonClass}
          onClick={() => onMove(1)}
          disabled={index >= count - 1}
        >
          Move down
        </button>
        <button type="button" className={buttonClass} onClick={onRemove}>
          Remove
        </button>
      </div>
      {block.rows.map((row, rowIndex) => (
        <div
          key={row.map((cell) => cell.id).join(":") || `row-${rowIndex}`}
          className={row.length > 1 ? "mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2" : "mt-4"}
        >
          {row.map((cell) => (
            <div key={cell.id} className="min-w-0">
              {cell.children.map((child) => (
                <ProseEditor key={child.id} node={child} onEdit={onEdit} onReport={onReport} />
              ))}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ProseEditor({
  node,
  onEdit,
  onReport,
}: {
  node: Prose;
  onEdit: (op: Op) => boolean;
  onReport: (message: string) => void;
}) {
  return (
    <div className="mt-4">
      {node.tag === "img" ? null : <StyleSelect node={node} onEdit={onEdit} />}
      {node.tag === "img" ? (
        <ImageEditor node={node} onEdit={onEdit} onReport={onReport} />
      ) : node.tag === "ul" || node.tag === "ol" ? (
        <ListEditor node={node} onEdit={onEdit} />
      ) : (
        <TextEditor
          tag={node.tag}
          text={node.text ?? ""}
          onCommit={(text) => onEdit({ op: "replaceText", nodeId: node.id, text })}
        />
      )}
    </div>
  );
}

function StyleSelect({ node, onEdit }: { node: Prose; onEdit: (op: Op) => boolean }) {
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
      Style
      <select
        className="border border-rule bg-paper px-2 py-1 text-sm text-ink"
        value={node.tag}
        onChange={(event) => {
          const tag = event.target.value as ProseTag;
          if (tag === node.tag) return;
          onEdit({ op: "setTag", nodeId: node.id, tag });
        }}
      >
        {styleChoices(node.tag).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextEditor({
  tag,
  text,
  onCommit,
}: {
  tag: "h1" | "h2" | "h3" | "h4" | "p";
  text: string;
  onCommit: (value: string) => boolean;
}) {
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.currentTarget.textContent ?? "";
    if (next === text) return;
    const ok = onCommit(next);
    if (!ok) event.currentTarget.textContent = text;
  };
  const className = [
    "mt-2 block min-h-[1.25em] w-full whitespace-pre-wrap break-words outline-none focus:bg-paper-2",
    textClass[tag],
    text === "" ? "border border-dashed border-rule px-2 py-1" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const shared = {
    contentEditable: true as const,
    suppressContentEditableWarning: true,
    role: "textbox" as const,
    "aria-label": `${tag} text`,
    "aria-multiline": true as const,
    className,
    onBlur,
    children: text,
  };
  if (tag === "h1") return <h1 {...shared} />;
  if (tag === "h2") return <h2 {...shared} />;
  if (tag === "h3") return <h3 {...shared} />;
  if (tag === "h4") return <h4 {...shared} />;
  return <p {...shared} />;
}

function ListEditor({ node, onEdit }: { node: Prose; onEdit: (op: Op) => boolean }) {
  const serialized = listText(node);
  const [value, setValue] = useState(serialized);

  useEffect(() => {
    setValue(serialized);
  }, [serialized]);

  return (
    <textarea
      aria-label={`${node.tag} text`}
      value={value}
      rows={4}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        if (value === serialized) return;
        const ok = onEdit({ op: "replaceText", nodeId: node.id, text: value });
        if (!ok) setValue(serialized);
      }}
      className="mt-2 min-h-24 w-full border border-rule bg-paper px-3 py-2 text-base leading-relaxed text-ink focus:border-ink focus:outline-none"
    />
  );
}

function ImageEditor({
  node,
  onEdit,
  onReport,
}: {
  node: Prose;
  onEdit: (op: Op) => boolean;
  onReport: (message: string) => void;
}) {
  const driveFileId = node.image?.driveFileId ?? "";
  const altText = node.image?.alt ?? "";
  const [alt, setAlt] = useState(altText);
  const [failed, setFailed] = useState(false);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    setAlt(altText);
  }, [altText]);

  useEffect(() => {
    setFailed(false);
  }, [driveFileId]);

  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/media", { method: "POST", body });
      const data = await readJson(response);
      const id = isRecord(data) && typeof data.driveFileId === "string" ? data.driveFileId : "";
      if (!response.ok || !id) {
        onReport(errorText(data, response));
        return;
      }
      onEdit({ op: "setImage", nodeId: node.id, driveFileId: id, alt });
    } catch (error) {
      onReport(messageOf(error));
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="mt-2">
      {driveFileId && !failed ? (
        // The bytes are a same-origin Drive proxy, addressed by file id.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={`/api/media/${driveFileId}`}
          alt={altText}
          className="max-w-full"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-32 items-center border border-dashed border-rule px-3 text-sm text-ink-soft">
          Image
        </div>
      )}
      <label className="mt-3 block text-sm text-ink">
        Replace image
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
          disabled={uploading}
          className="mt-1 block w-full text-sm"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      <label className="mt-3 block text-sm text-ink">
        Alt text
        <input
          type="text"
          value={alt}
          onChange={(event) => setAlt(event.target.value)}
          onBlur={() => {
            if (alt === altText) return;
            const ok = onEdit({
              op: "setImage",
              nodeId: node.id,
              driveFileId,
              alt,
            });
            if (!ok) setAlt(altText);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="mt-1 w-full border border-rule bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
        />
      </label>
    </div>
  );
}

function MetadataEditor({
  metadata,
  onEdit,
}: {
  metadata: Record<string, string>;
  onEdit: (op: Op) => boolean;
}) {
  return (
    <details className="mt-10 border border-rule">
      <summary className="cursor-pointer bg-paper-2 px-4 py-3 text-sm text-ink">
        Page metadata
      </summary>
      <div className="grid gap-4 border-t border-rule px-4 py-4">
        {(["title", "description", "template"] as const).map((key) => (
          <MetaField key={key} name={key} value={metadata[key] ?? ""} onEdit={onEdit} />
        ))}
      </div>
    </details>
  );
}

function MetaField({
  name,
  value,
  onEdit,
}: {
  name: "title" | "description" | "template";
  value: string;
  onEdit: (op: Op) => boolean;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <label className="block text-sm text-ink">
      <span className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">{name}</span>
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft === value) return;
          const ok = onEdit({ op: "setMetadata", key: name, value: draft });
          if (!ok) setDraft(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className="mt-2 w-full border border-rule bg-paper px-3 py-2 text-ink focus:border-ink focus:outline-none"
      />
    </label>
  );
}
