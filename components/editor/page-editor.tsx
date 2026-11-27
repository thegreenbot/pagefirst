"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { PreviewFrame } from "@/components/editor/preview-frame";
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
import { renderPage } from "@/lib/theme/engine";
import { withPresentation } from "@/lib/theme/presentation";
import { resolveTokens, tokenDefs, tokensCss as compileTokens, type TokenValues } from "@/lib/theme/tokens";
import type { AvailableTheme, PagePresentation, SiteThemeConfig } from "@/lib/site/theme-config";
import type { ThemePackage } from "@/lib/theme/package";

const buttonClass =
  "border border-rule bg-paper px-3 py-1.5 text-sm text-ink disabled:opacity-50";

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

/** Where a data-pf-id from the preview sits in the draft. */
type Located = { section: Section; block?: Block; prose?: Prose };

function locate(page: Page, id: string | null): Located | null {
  if (!id) return null;
  for (const section of page.sections) {
    if (section.id === id) return { section };
    for (const child of section.children) {
      if (child.id === id) return child.kind === "block" ? { section, block: child } : { section, prose: child };
      if (child.kind !== "block") continue;
      for (const row of child.rows) {
        for (const cell of row) {
          const prose = cell.children.find((node) => node.id === id);
          if (prose) return { section, block: child, prose };
        }
      }
    }
  }
  return null;
}

export function PageEditor({
  initial,
  sample,
  theme,
  nonce,
  siteConfig,
  presentation: initialPresentation,
  themes = [],
}: {
  initial: Page;
  sample: boolean;
  theme: ThemePackage;
  nonce: string;
  /** Null when there is no stored site (sample mode or no database). */
  siteConfig: Pick<SiteThemeConfig, "settings" | "tokens"> | null;
  presentation: PagePresentation | null;
  /** Themes the site can switch to (#64); empty without a stored site. */
  themes?: AvailableTheme[];
}) {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [presentation, setPresentation] = useState<PagePresentation>(
    () => initialPresentation ?? { template: "page", sectionStyles: {} },
  );

  const [brand, setBrand] = useState(() => ({
    tokens: { ...(siteConfig?.tokens ?? {}) } as TokenValues,
    settings: { ...(siteConfig?.settings ?? {}) },
  }));
  // Token changes swap CSS in the preview and never re-render templates (#57);
  // a render for another reason picks up the latest values from here.
  const tokensRef = useRef(brand.tokens);
  tokensRef.current = brand.tokens;
  const brandSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasSite = siteConfig !== null;

  modelRef.current = model;
  const dirty = model.pending.length > 0;
  const { draft } = model;
  const rendered = useMemo(() => {
    try {
      const site = hasSite ? { settings: brand.settings, tokens: tokensRef.current } : null;
      const applied = withPresentation(draft, site, site ? presentation : null);
      return { ...renderPage(applied.page, theme, { ...applied.options, mode: "edit" }), error: "" };
    } catch (error) {
      return { html: "", csp: "", warnings: [], error: messageOf(error) };
    }
  }, [draft, theme, hasSite, presentation, brand.settings]);
  const tokenStyle = useMemo(() => compileTokens(resolveTokens(theme, brand.tokens)), [theme, brand.tokens]);
  const located = locate(draft, selectedId);

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
    const node = paragraphNode();
    if (edit({ op: "insertProse", sectionId, index: section.children.length, node })) {
      setSelectedId(node.id);
      setFocusToken((token) => token + 1);
    }
  }

  function insertNamedBlock(sectionId: string, block: Block) {
    const section = findSection(modelRef.current.draft, sectionId);
    if (!section) return;
    if (edit({ op: "insertBlock", sectionId, index: section.children.length, block })) {
      setSelectedId(block.id);
    }
  }

  function moveBlock(sectionId: string, nodeId: string, direction: -1 | 1) {
    const section = findSection(modelRef.current.draft, sectionId);
    if (!section) return;
    const from = section.children.findIndex((node) => node.id === nodeId);
    const index = from + direction;
    if (from < 0 || index < 0 || index >= section.children.length) return;
    edit({ op: "moveNode", nodeId, toSectionId: sectionId, index });
  }

  function onPreviewText(id: string, text: string) {
    const node = locate(modelRef.current.draft, id)?.prose;
    if (!node || node.tag === "img" || node.tag === "ul" || node.tag === "ol") return;
    if ((node.text ?? "") === text) return;
    edit({ op: "replaceText", nodeId: id, text });
  }

  function changeBrand(next: { tokens: TokenValues; settings: Record<string, string | number | boolean> }) {
    setBrand(next);
    if (brandSave.current) clearTimeout(brandSave.current);
    brandSave.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/site/theme", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          });
          const data = await readJson(response);
          setStatus(response.ok ? "Brand saved." : errorText(data, response));
        } catch (error) {
          setStatus(messageOf(error));
        }
      })();
    }, 600);
  }

  async function savePresentation(next: PagePresentation) {
    const previous = presentation;
    setPresentation(next);
    try {
      const response = await fetch(`/api/pages/${modelRef.current.draft.fileId}/presentation`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      const data = await readJson(response);
      if (!response.ok) {
        setPresentation(previous);
        setStatus(errorText(data, response));
        return;
      }
      setStatus("Saved.");
    } catch (error) {
      setPresentation(previous);
      setStatus(messageOf(error));
    }
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
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
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
          className={`mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 ${status || conflict ? "pb-3" : ""}`}
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

      <main className="mx-auto grid max-w-6xl gap-6 bg-paper px-4 pb-24 pt-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {rendered.error ? (
            <p role="alert" className="border border-rule px-4 py-3 text-sm text-ink">
              The theme could not render this page: {rendered.error}
            </p>
          ) : (
            <PreviewFrame
              html={rendered.html}
              tokensCss={tokenStyle}
              nonce={nonce}
              selectedId={selectedId}
              focusToken={focusToken}
              onSelect={setSelectedId}
              onText={onPreviewText}
            />
          )}
        </div>
        <aside aria-label="Inspector" className="min-w-0 lg:sticky lg:top-24 lg:self-start">
          <Inspector
            located={located}
            sections={draft.sections}
            theme={theme}
            onEdit={edit}
            onReport={setStatus}
            onMove={(sectionId, nodeId, direction) => moveBlock(sectionId, nodeId, direction)}
            onRemove={(nodeId) => {
              if (edit({ op: "removeNode", nodeId })) setSelectedId(null);
            }}
            onInsertParagraph={insertParagraph}
            onInsertBlock={insertNamedBlock}
            presentation={siteConfig ? presentation : null}
            onPresentation={(next) => {
              void savePresentation(next);
            }}
          />
          {rendered.warnings.length > 0 ? (
            <ul className="mt-4 grid gap-1 text-xs text-ink-soft">
              {rendered.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
          {hasSite && themes.length > 1 ? (
            <ThemePicker current={theme.manifest.name} themes={themes} disabled={dirty} onStatus={setStatus} />
          ) : null}
          {hasSite ? <BrandPanel theme={theme} brand={brand} onChange={changeBrand} /> : null}
          <MetadataEditor metadata={draft.metadata} onEdit={edit} />
        </aside>
      </main>
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
        {(["title", "description"] as const).map((key) => (
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
  name: "title" | "description";
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

function Inspector({
  located,
  sections,
  theme,
  onEdit,
  onReport,
  onMove,
  onRemove,
  onInsertParagraph,
  onInsertBlock,
  presentation,
  onPresentation,
}: {
  located: Located | null;
  sections: Section[];
  theme: ThemePackage;
  onEdit: (op: Op) => boolean;
  onReport: (message: string) => void;
  onMove: (sectionId: string, nodeId: string, direction: -1 | 1) => void;
  onRemove: (nodeId: string) => void;
  onInsertParagraph: (sectionId: string) => void;
  onInsertBlock: (sectionId: string, block: Block) => void;
  /** Null when presentation cannot be stored (sample mode). */
  presentation: PagePresentation | null;
  onPresentation: (next: PagePresentation) => void;
}) {
  const section = located?.section ?? sections[sections.length - 1];
  const sectionNumber = section ? sections.indexOf(section) + 1 : 0;
  const { block, prose } = located ?? {};
  const blockIndex = block && section ? section.children.indexOf(block) : -1;
  const declared = block ? Object.hasOwn(theme.manifest.blocks, block.name) : true;

  return (
    <div className="grid gap-5 border border-rule px-4 py-4">
      {presentation ? (
        <label className="grid gap-1 text-sm text-ink">
          <span className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">Page template</span>
          <select
            className="border border-rule bg-paper px-2 py-1 text-sm text-ink"
            value={presentation.template}
            onChange={(event) => onPresentation({ ...presentation, template: event.target.value })}
          >
            {Object.entries(theme.manifest.templates).map(([name, template]) => (
              <option key={name} value={name}>
                {template.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {!located ? (
        <p className="text-sm text-ink-soft">Select part of the page to edit it. Type in headings and paragraphs directly.</p>
      ) : null}

      {block && section ? (
        <div className="grid gap-2">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-[0.14em] text-green">
            {block.options.length > 0 ? `${block.name} (${block.options.join(", ")})` : block.name}
            {!declared ? (
              <span className="border border-rule px-1.5 py-0.5 normal-case tracking-normal text-ink-soft">
                Not in this theme
              </span>
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={buttonClass}
              onClick={() => onMove(section.id, block.id, -1)}
              disabled={blockIndex <= 0}
            >
              Move up
            </button>
            <button
              type="button"
              className={buttonClass}
              onClick={() => onMove(section.id, block.id, 1)}
              disabled={blockIndex < 0 || blockIndex >= section.children.length - 1}
            >
              Move down
            </button>
            <button type="button" className={buttonClass} onClick={() => onRemove(block.id)}>
              Remove
            </button>
          </div>
        </div>
      ) : null}

      {prose ? (
        <div className="grid gap-2">
          {prose.tag === "img" ? null : <StyleSelect node={prose} onEdit={onEdit} />}
          {prose.tag === "img" ? (
            <ImageEditor key={prose.id} node={prose} onEdit={onEdit} onReport={onReport} />
          ) : prose.tag === "ul" || prose.tag === "ol" ? (
            <ListEditor key={prose.id} node={prose} onEdit={onEdit} />
          ) : (
            <p className="text-xs text-ink-soft">Edit the text in the page.</p>
          )}
          {!block ? (
            <button type="button" className={`${buttonClass} justify-self-start`} onClick={() => onRemove(prose.id)}>
              Remove
            </button>
          ) : null}
        </div>
      ) : null}

      {section ? (
        <div className="grid gap-2">
          {presentation && located && (theme.manifest.sectionStyles ?? []).length > 0 ? (
            <fieldset className="grid gap-1">
              <legend className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
                Section {sectionNumber} style
              </legend>
              {(theme.manifest.sectionStyles ?? []).map((style) => {
                const current = presentation.sectionStyles[section.id] ?? [];
                return (
                  <label key={style} className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={current.includes(style)}
                      onChange={(event) => {
                        const nextStyles = event.target.checked
                          ? [...current, style]
                          : current.filter((value) => value !== style);
                        const sectionStyles = { ...presentation.sectionStyles, [section.id]: nextStyles };
                        if (nextStyles.length === 0) delete sectionStyles[section.id];
                        onPresentation({ ...presentation, sectionStyles });
                      }}
                    />
                    {style}
                  </label>
                );
              })}
            </fieldset>
          ) : null}
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-ink-soft">
            Add to section {sectionNumber}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} onClick={() => onInsertParagraph(section.id)}>
              Paragraph
            </button>
            <button type="button" className={buttonClass} onClick={() => onInsertBlock(section.id, heroBlock())}>
              Hero
            </button>
            <button type="button" className={buttonClass} onClick={() => onInsertBlock(section.id, columnsBlock())}>
              Columns
            </button>
            <button type="button" className={buttonClass} onClick={() => onInsertBlock(section.id, cardsBlock())}>
              Cards
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type ChangeReportView = {
  from: { theme: string; version: string };
  to: { theme: string; version: string };
  pages: number;
  sampled: number;
  changed: number;
  overBudget: number;
  failed: number;
  diff: "pixels" | "markup";
  results: {
    fileId: string;
    path: string;
    previewPath: string | null;
    changed: boolean;
    breaches: { label: string; actual: number; limit: number; unit: string }[];
    pixelDiff: number | null;
    error: string | null;
  }[];
};

/** Republishes pages one by one, waiting out the publish rate limit. Returns the paths that failed. */
async function republish(pages: { fileId: string; path: string }[], onStatus: (message: string) => void): Promise<string[]> {
  const failed: string[] = [];
  for (const [index, page] of pages.entries()) {
    onStatus(`Republishing ${index + 1} of ${pages.length}: ${page.path}`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`/api/pages/${encodeURIComponent(page.fileId)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public: true }),
      });
      if (response.status === 429) {
        const wait = Math.min(60, Number(response.headers.get("Retry-After")) || 10);
        await new Promise((resolve) => setTimeout(resolve, wait * 1000));
        continue;
      }
      const body = (await readJson(response)) as { url?: string; warning?: string } | null;
      if (!response.ok || !body?.url) failed.push(page.path);
      break;
    }
  }
  return failed;
}

/**
 * Switches the site to another theme (#64), previewed first (#66): a sample
 * of the site's published pages is rendered with the new theme, and the
 * author sees which changed and whether any breaks a budget before applying.
 * Applying saves the new lock and republishes the site's pages; the editor
 * then reloads to pick up the new package, which is why uncommitted edits
 * block a switch.
 */
function ThemePicker({
  current,
  themes,
  disabled,
  onStatus,
}: {
  current: string;
  themes: AvailableTheme[];
  disabled: boolean;
  onStatus: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ id: string; report: ChangeReportView } | null>(null);

  async function choose(themeName: string) {
    if (themeName === current) return;
    setBusy(true);
    try {
      const response = await fetch("/api/site/theme/previews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ themeName }),
      });
      const body = await readJson(response);
      if (response.ok) setPreview(body as { id: string; report: ChangeReportView });
      else onStatus(errorText(body, response));
    } catch (error) {
      onStatus(messageOf(error));
    }
    setBusy(false);
  }

  async function resolve(action: "apply" | "discard") {
    if (!preview) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/site/theme/previews/${encodeURIComponent(preview.id)}/${action}`, { method: "POST" });
      const body = await readJson(response);
      if (!response.ok) {
        onStatus(errorText(body, response));
        setBusy(false);
        return;
      }
      if (action === "discard") {
        setPreview(null);
        onStatus("Theme change discarded.");
        setBusy(false);
        return;
      }
      const pages = (body as { republish: { fileId: string; path: string }[] }).republish;
      const failed = await republish(pages, onStatus);
      if (failed.length) {
        // Keep the message on screen; the editor picks up the new theme on the next load.
        onStatus(`Theme applied. These pages did not republish; publish them again: ${failed.join(", ")}`);
        setPreview(null);
        setBusy(false);
        return;
      }
      window.location.reload();
    } catch (error) {
      onStatus(messageOf(error));
      setBusy(false);
    }
  }

  const report = preview?.report;
  return (
    <div className="mt-6">
      <label className="block text-sm text-ink">
        Theme
        <select
          className="mt-1 w-full border border-rule bg-paper px-2 py-1 text-sm text-ink"
          value={preview ? report!.to.theme : current}
          disabled={disabled || busy || preview !== null}
          onChange={(event) => void choose(event.target.value)}
        >
          {themes.map((option) => (
            <option key={option.name} value={option.name}>
              {option.name.replace(/^@pagefirst\//, "")} {option.version}
            </option>
          ))}
        </select>
        {disabled ? <span className="mt-1 block text-xs text-ink-soft">Commit your edits before switching themes.</span> : null}
      </label>
      {report ? (
        <div className="mt-3 border border-rule px-3 py-3 text-sm text-ink" role="region" aria-label="Theme change preview">
          <p>
            {report.from.theme.replace(/^@pagefirst\//, "")} {report.from.version} to {report.to.theme.replace(/^@pagefirst\//, "")} {report.to.version}
          </p>
          <p className="mt-1 text-xs text-ink-soft">
            {report.sampled === 0
              ? "No published pages yet, so there is nothing to compare."
              : `${report.changed} of ${report.sampled} sampled pages change` +
                (report.pages > report.sampled ? ` (the site has ${report.pages})` : "") +
                `. ${report.overBudget ? `${report.overBudget} over budget.` : "All within budget."}` +
                (report.failed ? ` ${report.failed} could not render.` : "") +
                (report.diff === "markup" ? " Compared by markup." : "")}
          </p>
          <ul className="mt-2 grid gap-1 text-xs">
            {report.results.map((result) => (
              <li key={result.fileId}>
                {result.previewPath ? (
                  <a className="underline" href={result.previewPath} target="_blank" rel="noreferrer">
                    {result.path}
                  </a>
                ) : (
                  result.path
                )}{" "}
                {result.error
                  ? `could not render: ${result.error}`
                  : result.changed
                    ? `changed${result.pixelDiff !== null ? `, ${(result.pixelDiff * 100).toFixed(1)}% of pixels` : ""}`
                    : "unchanged"}
                {result.breaches.map((breach) => (
                  <span key={breach.label} className="block text-red-700">
                    Over budget: {breach.label} {breach.actual} &gt; {breach.limit} {breach.unit}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <button type="button" className="border border-ink px-3 py-1" disabled={busy} onClick={() => void resolve("apply")}>
              Apply and republish
            </button>
            <button type="button" className="border border-rule px-3 py-1" disabled={busy} onClick={() => void resolve("discard")}>
              Discard
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function BrandPanel({
  theme,
  brand,
  onChange,
}: {
  theme: ThemePackage;
  brand: { tokens: TokenValues; settings: Record<string, string | number | boolean> };
  onChange: (next: { tokens: TokenValues; settings: Record<string, string | number | boolean> }) => void;
}) {
  const defs = tokenDefs(theme);
  const settings = theme.manifest.settings ?? [];
  const inputClass = "mt-1 w-full border border-rule bg-paper px-2 py-1 text-sm text-ink";
  const setToken = (name: string, value: string) => {
    const tokens = { ...brand.tokens };
    if (value === "" || value === String(defs[name]?.value)) delete tokens[name];
    else tokens[name] = value;
    onChange({ ...brand, tokens });
  };
  const setSetting = (id: string, value: string | number | boolean) => onChange({ ...brand, settings: { ...brand.settings, [id]: value } });

  return (
    <details className="mt-6 border border-rule" open>
      <summary className="cursor-pointer bg-paper-2 px-4 py-3 text-sm text-ink">Brand</summary>
      <div className="grid gap-3 border-t border-rule px-4 py-4">
        {Object.entries(defs).map(([name, def]) => {
          const value = String(brand.tokens[name] ?? def.value);
          return (
            <label key={name} className="block text-sm text-ink">
              {def.label}
              {def.type === "color" && /^#[0-9a-fA-F]{6}$/.test(value) ? (
                <input
                  type="color"
                  aria-label={def.label}
                  value={value}
                  onChange={(event) => setToken(name, event.target.value)}
                  className="mt-1 block h-8 w-16 border border-rule bg-paper"
                />
              ) : (
                <input
                  type="text"
                  aria-label={def.label}
                  defaultValue={value}
                  onBlur={(event) => setToken(name, event.target.value.trim())}
                  className={inputClass}
                />
              )}
            </label>
          );
        })}
        {settings.map((setting) => {
          const value = brand.settings[setting.id] ?? setting.default;
          if (setting.type === "boolean") {
            return (
              <label key={setting.id} className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={value === true} onChange={(event) => setSetting(setting.id, event.target.checked)} />
                {setting.label}
              </label>
            );
          }
          if (setting.type === "select") {
            return (
              <label key={setting.id} className="block text-sm text-ink">
                {setting.label}
                <select className={inputClass} value={String(value ?? "")} onChange={(event) => setSetting(setting.id, event.target.value)}>
                  {(setting.options ?? []).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            );
          }
          return (
            <label key={setting.id} className="block text-sm text-ink">
              {setting.label}
              <input
                type={setting.type === "number" ? "number" : setting.type === "color" ? "color" : "text"}
                defaultValue={value === undefined ? "" : String(value)}
                onBlur={(event) => setSetting(setting.id, setting.type === "number" ? Number(event.target.value) : event.target.value)}
                className={inputClass}
              />
            </label>
          );
        })}
      </div>
    </details>
  );
}
