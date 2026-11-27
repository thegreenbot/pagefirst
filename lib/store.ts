import { batchUpdate, createDocument, fetchDocument, listDocuments } from "@/lib/google/docs";
import { buildAdoptRequests, buildCommitRequests } from "@/lib/google/commit";
import { googleConfigured } from "@/lib/google/config";
import { aboutFixture, blankPage } from "@/lib/page/fixture";
import { applyOps } from "@/lib/page/ops";
import { parseDocument } from "@/lib/page/parse";
import { redact } from "@/lib/log";
import { getAccessToken } from "@/lib/session";
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

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "page";
}

function toSummary(page: Page): PageSummary {
  return {
    fileId: page.fileId,
    path: page.path,
    title: pageTitle(page),
    revisionId: page.revisionId,
  };
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Commit failed";
}


export async function isSampleMode(): Promise<boolean> {
  if (!googleConfigured()) return true;
  const token = await getAccessToken();
  return !token;
}

export async function listPages(): Promise<Library> {
  if (await isSampleMode()) {
    ensureSample();
    return { sample: true, pages: [...samplePages.values()].map(toSummary) };
  }
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in");
  const files = await listDocuments(token);
  return {
    sample: false,
    pages: files.map((file) => ({
      fileId: file.id,
      path: slugify(file.name),
      title: file.name,
      revisionId: "",
    })),
  };
}

export async function getPage(fileId: string): Promise<PagePayload | null> {
  if (await isSampleMode()) {
    if (!isSafeId(fileId)) return null;
    ensureSample();
    const page = samplePages.get(fileId);
    return page ? { page, sample: true } : null;
  }
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in");
  try {
    const doc = await fetchDocument(token, fileId);
    return { page: parseDocument(doc, slugify(doc.title ?? "")), sample: false };
  } catch (err) {
    if (errorText(err).includes("(404)")) return null;
    throw err;
  }
}

export async function createPage(title: string): Promise<PagePayload> {
  if (await isSampleMode()) {
    ensureSample();
    const page = blankPage(title);
    samplePages.set(page.fileId, page);
    return { page, sample: true };
  }
  const token = await getAccessToken();
  if (!token) throw new Error("Not signed in");
  const doc = await createDocument(token, title);
  return { page: parseDocument(doc, slugify(doc.title || title)), sample: false };
}

function commitSample(fileId: string, baseRevisionId: string, ops: Op[]): CommitResult {
  if (!isSafeId(fileId)) return { ok: false, status: 404, error: "Page not found" };
  ensureSample();
  const current = samplePages.get(fileId);
  if (!current) return { ok: false, status: 404, error: "Page not found" };
  if (baseRevisionId !== current.revisionId) {
    return {
      ok: false,
      status: 409,
      error: "This doc changed. Reload to see it.",
      page: current,
    };
  }
  try {
    const page = applyOps(structuredClone(current), ops);
    samplePages.set(fileId, page);
    return { ok: true, page, sample: true };
  } catch (err) {
    return { ok: false, status: 400, error: errorText(err) };
  }
}

async function commitLive(
  token: string,
  fileId: string,
  baseRevisionId: string,
  ops: Op[],
): Promise<CommitResult> {
  let doc = await fetchDocument(token, fileId);
  if (doc.revisionId && doc.revisionId !== baseRevisionId) {
    return {
      ok: false,
      status: 409,
      error: "This doc changed. Reload to see it.",
      page: parseDocument(doc, slugify(doc.title ?? "")),
    };
  }

  let requests: object[];
  try {
    requests = buildCommitRequests(doc, ops).requests;
  } catch (err) {
    if (!errorText(err).includes("Missing named range")) throw err;
    const adopt = buildAdoptRequests(doc).requests;
    if (adopt.length === 0) throw err;
    await batchUpdate(token, fileId, adopt);
    doc = await fetchDocument(token, fileId);
    requests = buildCommitRequests(doc, ops).requests;
  }

  if (requests.length > 0) await batchUpdate(token, fileId, requests);
  const updated = await fetchDocument(token, fileId);
  return {
    ok: true,
    page: parseDocument(updated, slugify(updated.title ?? "")),
    sample: false,
  };
}

export async function commitPage(
  fileId: string,
  baseRevisionId: string,
  ops: Op[],
): Promise<CommitResult> {
  if (await isSampleMode()) return commitSample(fileId, baseRevisionId, ops);
  const token = await getAccessToken();
  if (!token) return { ok: false, status: 502, error: "Not signed in" };
  try {
    return await commitLive(token, fileId, baseRevisionId, ops);
  } catch (err) {
    const message = redact(errorText(err), token);
    if (errorText(err).includes("does not support")) {
      return { ok: false, status: 501, error: message };
    }
    return { ok: false, status: 502, error: message };
  }
}
