import { buildAdoptRequests, buildCommitRequests } from "@/lib/google/commit";
import { googleConfigured } from "@/lib/google/config";
import { redact } from "@/lib/log";
import { aboutFixture, blankPage } from "@/lib/page/fixture";
import { applyOps } from "@/lib/page/ops";
import { parseDocument } from "@/lib/page/parse";
import {
  isSafeId,
  pageTitle,
  type CommitResult,
  type Library,
  type Op,
  type Page,
  type PagePayload,
  type PageSummary,
} from "@/lib/page/types";
import { messageOf, realGoogle, toServiceError } from "./google";
import { requireScope, ServiceError, type GoogleClient, type ServiceContext } from "./context";

const sampleHolder = globalThis as typeof globalThis & {
  __pageFirstSamplePages?: Map<string, Page>;
  __pageFirstSampleReady?: boolean;
};

const samplePages: Map<string, Page> =
  sampleHolder.__pageFirstSamplePages ?? new Map<string, Page>();
sampleHolder.__pageFirstSamplePages = samplePages;

function ensureSample(): void {
  if (sampleHolder.__pageFirstSampleReady) return;
  const about = aboutFixture();
  const notes = blankPage("Notes");
  samplePages.set(about.fileId, about);
  samplePages.set(notes.fileId, notes);
  sampleHolder.__pageFirstSampleReady = true;
}

/** Test hook: forget every sample page. */
export function resetSamplePages(): void {
  samplePages.clear();
  sampleHolder.__pageFirstSampleReady = false;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

function toSummary(page: Page): PageSummary {
  return { fileId: page.fileId, path: page.path, title: pageTitle(page), revisionId: page.revisionId };
}

/** Sample mode: no Google configured, or nobody signed in. */
export function isSample(ctx: ServiceContext): boolean {
  return !googleConfigured() || !ctx.googleToken;
}

export function googleFor(ctx: ServiceContext): GoogleClient {
  return ctx.google ?? realGoogle;
}

/**
 * Enforces a key's site-folder allow-list. Fails closed: with an allow-list
 * and no way to look up a file's folder, the call is refused. Sample pages
 * are not in any folder, so a restricted credential cannot reach them.
 */
async function requireFolder(ctx: ServiceContext, fileId: string): Promise<void> {
  if (!ctx.siteFolders) return;
  const token = ctx.googleToken;
  const parentsOf = googleFor(ctx).parentsOf;
  if (!token || !parentsOf) throw new ServiceError("forbidden", "This credential is limited to certain site folders.");
  let parents: string[];
  try {
    parents = await parentsOf(token, fileId);
  } catch (err) {
    throw toServiceError(err, "Could not check the page's folder.", (text) => redact(text, token));
  }
  if (!parents.some((id) => ctx.siteFolders!.includes(id))) {
    // Same answer as a missing page, so a key cannot probe what exists outside its folders.
    throw new ServiceError("not_found", "Page not found");
  }
}

function liveToken(ctx: ServiceContext): string {
  if (!ctx.googleToken) throw new ServiceError("unauthenticated", "Not signed in");
  return ctx.googleToken;
}

export async function listPages(ctx: ServiceContext): Promise<Library> {
  requireScope(ctx, "pages:read");
  if (isSample(ctx)) {
    ensureSample();
    return { sample: true, pages: [...samplePages.values()].map(toSummary) };
  }
  const token = liveToken(ctx);
  try {
    const files = await googleFor(ctx).listDocuments(token, ctx.siteFolders);
    return {
      sample: false,
      pages: files.map((file) => ({ fileId: file.id, path: slugify(file.name), title: file.name, revisionId: "", ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}) })),
    };
  } catch (err) {
    throw toServiceError(err, "Could not list pages.", (text) => redact(text, token));
  }
}

/** Null when the page does not exist or the caller cannot see it. */
export async function getPage(ctx: ServiceContext, fileId: string): Promise<PagePayload | null> {
  requireScope(ctx, "pages:read");
  if (!isSafeId(fileId)) return null;
  if (isSample(ctx)) {
    ensureSample();
    const page = samplePages.get(fileId);
    return page ? { page, sample: true } : null;
  }
  const token = liveToken(ctx);
  try {
    await requireFolder(ctx, fileId);
    const doc = await googleFor(ctx).fetchDocument(token, fileId);
    return { page: parseDocument(doc, slugify(doc.title ?? "")), sample: false };
  } catch (err) {
    const typed = toServiceError(err, "Could not read the page.", (text) => redact(text, token));
    if (typed.code === "not_found") return null;
    throw typed;
  }
}

export async function createPage(ctx: ServiceContext, title: string): Promise<PagePayload> {
  requireScope(ctx, "pages:commit");
  // A new Doc lands in the user's Drive root, outside any folder this credential may use.
  if (ctx.siteFolders) throw new ServiceError("forbidden", "This credential is limited to certain site folders and cannot create pages.");
  if (isSample(ctx)) {
    ensureSample();
    const page = blankPage(title);
    samplePages.set(page.fileId, page);
    return { page, sample: true };
  }
  const token = liveToken(ctx);
  try {
    const doc = await googleFor(ctx).createDocument(token, title);
    return { page: parseDocument(doc, slugify(doc.title || title)), sample: false };
  } catch (err) {
    throw toServiceError(err, "Could not create the page.", (text) => redact(text, token));
  }
}

function commitSample(fileId: string, baseRevisionId: string, ops: Op[]): CommitResult {
  if (!isSafeId(fileId)) return fail("not_found", "Page not found");
  ensureSample();
  const current = samplePages.get(fileId);
  if (!current) return fail("not_found", "Page not found");
  if (baseRevisionId !== current.revisionId) {
    return fail("conflict", "This doc changed. Reload to see it.", current);
  }
  try {
    const page = applyOps(structuredClone(current), ops);
    samplePages.set(fileId, page);
    return { ok: true, page, sample: true };
  } catch (err) {
    return fail("invalid", messageOf(err, "Commit failed"));
  }
}

function fail(code: ServiceError["code"], error: string, page?: Page): CommitResult {
  const typed = new ServiceError(code, error);
  return { ok: false, status: typed.status, code, error, ...(page ? { page } : {}) };
}

async function commitLive(ctx: ServiceContext, token: string, fileId: string, baseRevisionId: string, ops: Op[]): Promise<CommitResult> {
  const google = googleFor(ctx);
  let doc = await google.fetchDocument(token, fileId);
  if (doc.revisionId && doc.revisionId !== baseRevisionId) {
    return fail("conflict", "This doc changed. Reload to see it.", parseDocument(doc, slugify(doc.title ?? "")));
  }

  let requests: object[];
  try {
    requests = buildCommitRequests(doc, ops).requests;
  } catch (err) {
    if (!messageOf(err, "").includes("Missing named range")) throw err;
    const adopt = buildAdoptRequests(doc).requests;
    if (adopt.length === 0) throw err;
    await google.batchUpdate(token, fileId, adopt);
    doc = await google.fetchDocument(token, fileId);
    requests = buildCommitRequests(doc, ops).requests;
  }

  if (requests.length > 0) await google.batchUpdate(token, fileId, requests);
  const updated = await google.fetchDocument(token, fileId);
  return { ok: true, page: parseDocument(updated, slugify(updated.title ?? "")), sample: false };
}

/**
 * Applies ops to a page. Failures come back as `{ ok: false, code, status }`;
 * a missing scope throws `forbidden` before anything is read.
 */
export async function commit(ctx: ServiceContext, fileId: string, baseRevisionId: string, ops: Op[]): Promise<CommitResult> {
  requireScope(ctx, "pages:commit");
  if (isSample(ctx)) return commitSample(fileId, baseRevisionId, ops);
  const token = ctx.googleToken;
  if (!token) return fail("unauthenticated", "Not signed in");
  // Outside the try: a folder refusal keeps its own code instead of becoming a Google 502.
  try {
    await requireFolder(ctx, fileId);
  } catch (err) {
    if (err instanceof ServiceError) return fail(err.code, err.message);
    throw err;
  }
  try {
    return await commitLive(ctx, token, fileId, baseRevisionId, ops);
  } catch (err) {
    const typed = toServiceError(err, "Commit failed", (text) => redact(text, token));
    // Google failures reach callers as 502 unless they are a quota or a known unsupported op.
    const code = typed.code === "unsupported" || typed.code === "upstream_quota" ? typed.code : "upstream_error";
    return { ok: false, status: code === "upstream_quota" ? 429 : typed.status === 501 ? 501 : 502, code, error: typed.message };
  }
}
