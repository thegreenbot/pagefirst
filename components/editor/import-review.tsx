"use client";

import { useEffect, useState } from "react";
import type { PageChange, TextSegment } from "@/lib/page/diff";
import type { Conflict } from "@/lib/page/merge";
import type { Op, Page } from "@/lib/page/types";

type Report = {
  reviewedRevisionId: string;
  changes: PageChange[];
  conflicts: Conflict[];
  docAuthor: string | null;
  docModifiedTime: string | null;
  opaque: { suggestions: number };
};

type Choice = "doc" | "draft";

const buttonClass = "border border-rule bg-paper px-3 py-1.5 text-sm text-ink disabled:opacity-50";

function sectionOf(change: PageChange): string {
  switch (change.kind) {
    case "meta.added":
    case "meta.removed":
    case "meta.changed":
      return "Page details";
    case "section.added":
    case "section.removed":
    case "section.moved":
    case "section.style":
      return `Section ${change.sectionId}`;
    case "node.added":
    case "node.untracked":
      return `Section ${change.at.sectionId}`;
    case "node.removed":
    case "node.moved":
      return `Section ${"from" in change ? change.from.sectionId : ""}`;
    default:
      return "Content";
  }
}

function label(change: PageChange): string {
  switch (change.kind) {
    case "meta.added": return `Added ${change.key}`;
    case "meta.removed": return `Removed ${change.key}`;
    case "meta.changed": return `Changed ${change.key}`;
    case "section.added": return "New section";
    case "section.removed": return "Section removed";
    case "section.moved": return "Section moved";
    case "section.style": return "Section style changed";
    case "node.added":
    case "node.untracked": return "New content";
    case "node.removed": return "Content removed";
    case "node.moved": return "Content moved";
    case "prose.text": return "Text changed";
    case "prose.tag": return `Style changed from ${change.before} to ${change.after}`;
    case "image.changed": return "Image changed";
    case "block.name": return `Block renamed to ${change.after}`;
    case "block.options": return "Block options changed";
    case "block.shape": return "Block layout changed";
    case "cell.content": return `Table cell ${change.row + 1}, ${change.col + 1} changed`;
  }
}

function Segments({ segments, side }: { segments: TextSegment[]; side?: "before" | "after" }) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm text-ink">
      {segments.map((segment, index) => {
        if (side === "before" && segment.op === "insert") return null;
        if (side === "after" && segment.op === "delete") return null;
        if (segment.op === "insert") return <ins key={index} className="bg-paper-2 underline">{segment.text}</ins>;
        if (segment.op === "delete") return <del key={index} className="text-ink-soft">{segment.text}</del>;
        return <span key={index}>{segment.text}</span>;
      })}
    </p>
  );
}

function ChangeView({ change }: { change: PageChange }) {
  const [view, setView] = useState<"diff" | "before" | "after">("diff");
  const diff = change.kind === "prose.text" || change.kind === "cell.content" ? change.diff : null;
  return (
    <li className="border-b border-rule py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-ink">{label(change)}</span>
        {diff ? (
          <span className="ml-auto flex gap-1 text-xs" role="group" aria-label="Preview">
            {(["diff", "before", "after"] as const).map((mode) => (
              <button key={mode} type="button" aria-pressed={view === mode} className={`border border-rule px-2 py-0.5 ${view === mode ? "bg-paper-2" : "bg-paper"}`} onClick={() => setView(mode)}>
                {mode === "diff" ? "Changes" : mode === "before" ? "Before" : "After"}
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {diff ? <Segments segments={diff} side={view === "diff" ? undefined : view} /> : null}
      {change.kind === "meta.changed" ? <p className="text-sm text-ink-soft">{change.before} → {change.after}</p> : null}
      {change.kind === "meta.added" ? <p className="text-sm text-ink-soft">{change.after}</p> : null}
      {change.kind === "meta.removed" ? <p className="text-sm text-ink-soft line-through">{change.before}</p> : null}
      {(change.kind === "node.added" || change.kind === "node.untracked") && change.node.kind === "prose" ? <p className="text-sm text-ink-soft">{change.node.text}</p> : null}
      {change.kind === "node.removed" && change.node.kind === "prose" ? <p className="text-sm text-ink-soft line-through">{change.node.text}</p> : null}
    </li>
  );
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function conflictUnitLabel(conflict: Conflict): string {
  return conflict.unit.startsWith("meta:") ? `Page detail “${conflict.unit.slice(5)}”` : conflict.unit.startsWith("node:") ? "A paragraph or block" : "Page structure";
}

/**
 * Review of what changed in the Google Doc since this page was last saved (#35).
 * The Doc's changes are always taken (it is the source of truth); the author's
 * uncommitted edits are kept on top unless they pick the Doc's version of a
 * conflicting one.
 */
export function ImportReview({
  fileId,
  baseRevisionId,
  ops,
  onApply,
  onClose,
}: {
  fileId: string;
  baseRevisionId: string;
  ops: Op[];
  onApply: (docPage: Page, keepDoc: ReadonlySet<string>) => void;
  onClose: () => void;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const response = await fetch(`/api/pages/${encodeURIComponent(fileId)}/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dryRun: true, baseRevisionId, ops }),
        });
        const data = (await response.json()) as Report & { error?: string };
        if (!live) return;
        if (!response.ok) setError(data.error ?? "Could not read the Doc's changes.");
        else setReport(data);
      } catch {
        if (live) setError("Could not read the Doc's changes.");
      }
    })();
    return () => {
      live = false;
    };
    // The review is of the draft as it was when opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply() {
    if (!report) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/pages/${encodeURIComponent(fileId)}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun: false, expectRevisionId: report.reviewedRevisionId }),
      });
      const data = (await response.json()) as { page?: Page; error?: string };
      if (!response.ok || !data.page) {
        setError(response.status === 409 ? "The Doc changed again while you were reviewing. Review again." : (data.error ?? "Import failed."));
        if (response.status === 409) setReport(null);
        return;
      }
      const keepDoc = new Set(report.conflicts.filter((c) => (choices[c.unit] ?? "draft") === "doc").map((c) => c.unit));
      onApply(data.page, keepDoc);
    } catch {
      setError("Import failed.");
    } finally {
      setBusy(false);
    }
  }

  const groups = new Map<string, PageChange[]>();
  for (const change of report?.changes ?? []) {
    const key = sectionOf(change);
    groups.set(key, [...(groups.get(key) ?? []), change]);
  }

  return (
    <section aria-label="Review changes from Google Docs" className="mx-auto max-w-6xl border border-rule bg-paper px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-medium text-ink">Changes from Google Docs</h2>
        {report?.docAuthor ? <span className="text-sm text-ink-soft">by {report.docAuthor}</span> : null}
        <button type="button" className={`${buttonClass} ml-auto`} onClick={onClose}>Close</button>
      </div>
      {error ? <p role="alert" className="py-2 text-sm text-ink">{error}</p> : null}
      {!report && !error ? <p role="status" className="py-2 text-sm text-ink-soft">Reading the Doc…</p> : null}
      {report ? (
        <>
          {report.changes.length === 0 ? <p className="py-2 text-sm text-ink-soft">Nothing has changed in the Doc since the last import.</p> : null}
          {[...groups.entries()].map(([name, changes]) => (
            <div key={name} className="py-2">
              <h3 className="text-sm text-ink-soft">{name}</h3>
              <ul>{changes.map((change, index) => <ChangeView key={index} change={change} />)}</ul>
            </div>
          ))}
          {report.opaque.suggestions > 0 ? (
            <p className="py-2 text-sm text-ink-soft">{report.opaque.suggestions} suggested edit{report.opaque.suggestions === 1 ? "" : "s"} in the Doc {report.opaque.suggestions === 1 ? "is" : "are"} not imported. Accept or reject {report.opaque.suggestions === 1 ? "it" : "them"} in Google Docs.</p>
          ) : null}
          {report.conflicts.length > 0 ? (
            <div className="py-2">
              <h3 className="text-sm font-medium text-ink">Your edits conflict with the Doc</h3>
              <ul>
                {report.conflicts.map((conflict) => {
                  const choice = choices[conflict.unit] ?? "draft";
                  return (
                    <li key={conflict.unit} className="border-b border-rule py-2">
                      <fieldset>
                        <legend className="text-sm text-ink">{conflictUnitLabel(conflict)}</legend>
                        <label className="mt-1 block text-sm text-ink">
                          <input type="radio" name={conflict.unit} checked={choice === "draft"} onChange={() => setChoices({ ...choices, [conflict.unit]: "draft" })} /> Keep my draft: <span className="text-ink-soft">{show(conflict.draft)}</span>
                        </label>
                        <label className="block text-sm text-ink">
                          <input type="radio" name={conflict.unit} checked={choice === "doc"} onChange={() => setChoices({ ...choices, [conflict.unit]: "doc" })} /> Keep the Doc’s: <span className="text-ink-soft">{show(conflict.doc)}</span>
                        </label>
                      </fieldset>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          <div className="flex gap-2 pt-2">
            <button type="button" className={buttonClass} disabled={busy} onClick={() => void apply()}>
              {report.changes.length === 0 ? "Refresh from Doc" : "Accept changes"}
            </button>
            <button type="button" className={buttonClass} onClick={onClose}>Not now</button>
          </div>
        </>
      ) : null}
    </section>
  );
}
