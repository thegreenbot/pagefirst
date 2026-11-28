import { planAdopt, type AdoptReport } from "@/lib/google/adopt";
import { countSuggestions } from "@/lib/google/suggestions";
import { newImportId, recordImport } from "@/lib/import/store";
import { diffPages, untrackedNodeIds, type PageChange } from "@/lib/page/diff";
import { CONFLICT_POLICIES, mergePages, type Conflict, type ConflictPolicy } from "@/lib/page/merge";
import { applyOps } from "@/lib/page/ops";
import { parseDocument } from "@/lib/page/parse";
import { isSafeId, type Op, type Page } from "@/lib/page/types";
import { redact } from "@/lib/log";
import { baseSnapshot } from "@/lib/snapshots/store";
import { requireScope, ServiceError, type ServiceContext } from "./context";
import { googleFor, isSample, requireFolder, slugify } from "./pages";
import { toServiceError } from "./google";
import { publish, type PublishOutcome } from "./publish";
import { snapshotPage } from "./snapshots";

/**
 * Importing a Doc's changes (#34, docs/adr/0006-import-model.md): adopt untracked
 * content, diff the Doc against its base snapshot, merge with an optional local
 * draft by policy, and record a snapshot with `source: import`. It never
 * publishes; `importAndPublish` is a separate recorded step.
 */

export type ImportOptions = {
  /** How to settle a node both the Doc and the draft changed. Default `doc-wins` with no draft, else `manual`. */
  policy?: ConflictPolicy;
  /** Report only: no Doc write, no snapshot. */
  dryRun?: boolean;
  /** Refuse, before writing anything, unless the Doc is still at this revision: the one a reviewer saw in a dry run. */
  expectRevisionId?: string;
  /** The editor's uncommitted ops, so conflicts with the Doc can be found. Automated callers have none. */
  draftOps?: Op[];
};

export type ImportResult = {
  importId: string;
  fileId: string;
  dryRun: boolean;
  policy: ConflictPolicy;
  /** True when Pagefirst had no snapshot of this Doc, so everything counts as new. */
  firstImport: boolean;
  fromRevisionId: string | null;
  /** The Doc's revision when the import started, before adopting. A dry run reports it, and an approved run pins it. */
  reviewedRevisionId: string;
  toRevisionId: string;
  /** What changed in the Doc since the base snapshot. */
  changes: PageChange[];
  conflicts: Conflict[];
  /** A person still has to settle a conflict (`manual`), or `fail` stopped the import. */
  needsReview: boolean;
  ok: boolean;
  /** What adopting untracked content did, or on a dry run would do. */
  adopt: AdoptReport;
  /** Content the import reports but does not bring in. */
  opaque: { suggestions: number };
  docAuthor: string | null;
  docModifiedTime: string | null;
  /** The Doc merged with the draft, for the editor. Equal to the Doc when there is no draft. */
  page: Page;
};

const EMPTY: Omit<Page, "fileId" | "revisionId" | "path"> = { metadata: {}, sections: [] };

export function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return typeof value === "string" && (CONFLICT_POLICIES as readonly string[]).includes(value);
}

export async function importPage(ctx: ServiceContext, fileId: string, options: ImportOptions = {}): Promise<ImportResult> {
  requireScope(ctx, "pages:import");
  if (!isSafeId(fileId)) throw new ServiceError("invalid", "Invalid page id.");
  if (isSample(ctx)) throw new ServiceError("unsupported", "Sample pages have no Google Doc to import.");
  const token = ctx.googleToken;
  if (!token) throw new ServiceError("unauthenticated", "Not signed in");
  const dryRun = options.dryRun === true;
  const policy = options.policy ?? (options.draftOps ? "manual" : "doc-wins");

  try {
    await requireFolder(ctx, fileId);
    const google = googleFor(ctx);
    let doc = await google.fetchDocument(token, fileId);
    const reviewedRevisionId = doc.revisionId ?? "";
    if (options.expectRevisionId && reviewedRevisionId !== options.expectRevisionId) {
      throw new ServiceError("conflict", "The Doc changed since it was reviewed. Run the import again.");
    }

    // Adopt untracked content first: a Doc write of named ranges only, covered by the import scope.
    const plan = planAdopt(doc);
    const untracked = dryRun || plan.requests.length === 0 ? untrackedNodeIds(doc, parseDocument(doc)) : new Set<string>();
    if (!dryRun && plan.requests.length > 0) {
      await google.batchUpdate(token, fileId, plan.requests);
      doc = await google.fetchDocument(token, fileId);
    }

    const docPage = parseDocument(doc, slugify(doc.title ?? ""));
    const base = await baseSnapshot(fileId);
    const basePage: Page = base?.page ?? { fileId: docPage.fileId, revisionId: "", path: docPage.path, ...EMPTY };
    const changes = diffPages(basePage, docPage, { untracked });
    const draft = options.draftOps?.length ? applyOps(basePage, options.draftOps) : null;
    const merged = mergePages(basePage, docPage, draft, policy);

    let docAuthor: string | null = null;
    let docModifiedTime: string | null = null;
    if (google.driveMeta) {
      try {
        const meta = await google.driveMeta(token, fileId);
        docModifiedTime = meta.modifiedTime;
        docAuthor = meta.lastModifiedBy?.email ?? meta.lastModifiedBy?.name ?? null;
      } catch {
        // Attribution is best effort; the import still stands.
      }
    }

    const needsReview = merged.needsReview || !merged.ok;
    const importId = newImportId();
    const result: ImportResult = {
      importId,
      fileId,
      dryRun,
      policy,
      firstImport: base === null,
      fromRevisionId: base?.revisionId ?? null,
      reviewedRevisionId,
      toRevisionId: docPage.revisionId,
      changes,
      conflicts: merged.conflicts,
      needsReview,
      ok: merged.ok,
      adopt: plan.report,
      opaque: { suggestions: countSuggestions(doc) },
      docAuthor,
      docModifiedTime,
      page: merged.page,
    };
    await recordImport({
      id: importId,
      fileId,
      actorSub: ctx.actor.sub,
      policy,
      dryRun,
      fromRevisionId: result.fromRevisionId,
      toRevisionId: result.toRevisionId,
      changeCount: changes.length,
      conflictCount: merged.conflicts.length,
      adopted: plan.report.adopted,
      suggestions: result.opaque.suggestions,
      docAuthor,
      docModifiedTime,
    });
    // The Doc as it now stands becomes the base for the next import, unless a person still has to settle it.
    if (!dryRun && !needsReview) await snapshotPage(ctx, google, docPage, "import", { importId });
    return result;
  } catch (err) {
    throw toServiceError(err, "Could not import the page.", (text) => redact(text, token));
  }
}

export type ImportAndPublishResult = {
  import: ImportResult;
  /** Null when the import held something back; `reason` says why. */
  publish: PublishOutcome | null;
  reason: "conflicts" | null;
};

/**
 * Imports, then publishes exactly the revision the import produced. Held back
 * when a conflict needs a person. If the Doc moved on between the two steps the
 * publish fails with a conflict instead of publishing unreviewed content.
 */
export async function importAndPublish(
  ctx: ServiceContext,
  fileId: string,
  options: Omit<ImportOptions, "dryRun"> & { public?: boolean; allowSuggestions?: boolean } = {},
): Promise<ImportAndPublishResult> {
  requireScope(ctx, "pages:import");
  requireScope(ctx, options.public ? "pages:publish" : "pages:read");
  const imported = await importPage(ctx, fileId, { ...options, dryRun: false });
  if (imported.needsReview) return { import: imported, publish: null, reason: "conflicts" };
  const outcome = await publish(ctx, fileId, {
    revisionId: imported.toRevisionId,
    public: options.public === true,
    importId: imported.importId,
    allowSuggestions: options.allowSuggestions,
  });
  return { import: imported, publish: outcome, reason: null };
}
