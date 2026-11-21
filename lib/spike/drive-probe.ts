/**
 * drive.file access spike. Not product code.
 *
 * Every probe runs with the signed-in caller's own token and reports only
 * HTTP status plus a small whitelist of fields. Response bodies on failure are
 * reduced to Google's error `status`/`reason`, never echoed raw, and the token
 * never appears in output.
 */

const DRIVE = "https://www.googleapis.com/drive/v3";
const DOCS = "https://docs.googleapis.com/v1";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";
const MAX_PARENT_HOPS = 20;

/** Enabled only with PAGEFIRST_SPIKE=1, and never on a Vercel production deploy. */
export function spikeEnabled(): boolean {
  return process.env.PAGEFIRST_SPIKE === "1" && process.env.VERCEL_ENV !== "production";
}

const ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;
export function isDriveId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

export type ProbeResult = {
  probe: string;
  status: number;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: string;
};

async function call(
  token: string,
  url: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

function googleError(json: unknown): string {
  if (!json || typeof json !== "object") return "no body";
  const err = (json as { error?: unknown }).error;
  if (!err || typeof err !== "object") return "no error object";
  const e = err as { status?: unknown; errors?: { reason?: unknown }[] };
  const reason = Array.isArray(e.errors) && typeof e.errors[0]?.reason === "string" ? e.errors[0].reason : "";
  const status = typeof e.status === "string" ? e.status : "";
  return [status, reason].filter(Boolean).join(" / ") || "unknown";
}

function pick(json: unknown, keys: string[]): Record<string, unknown> {
  if (!json || typeof json !== "object") return {};
  const source = json as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

function result(probe: string, status: number, json: unknown, keys: string[]): ProbeResult {
  const ok = status >= 200 && status < 300;
  return ok ? { probe, status, ok, data: pick(json, keys) } : { probe, status, ok, error: googleError(json) };
}

export async function whoami(token: string): Promise<ProbeResult> {
  const { status, json } = await call(token, USERINFO);
  return result("userinfo", status, json, ["sub", "email", "email_verified"]);
}

const FILE_FIELDS =
  "id,name,mimeType,parents,capabilities(canEdit,canAddChildren,canListChildren,canShare,canRename)";

export async function driveGet(token: string, id: string, label: string): Promise<ProbeResult> {
  const url = `${DRIVE}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`;
  const { status, json } = await call(token, url);
  return result(`drive.files.get ${label}`, status, json, ["id", "name", "mimeType", "parents", "capabilities"]);
}

export async function driveListChildren(token: string, folderId: string): Promise<ProbeResult> {
  const q = `'${folderId}' in parents and trashed=false`;
  const url = `${DRIVE}/files?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,mimeType)")}&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`;
  const { status, json } = await call(token, url);
  return result("drive.files.list children", status, json, ["files"]);
}

export async function docsGet(token: string, docId: string): Promise<ProbeResult> {
  const url = `${DOCS}/documents/${encodeURIComponent(docId)}?fields=${encodeURIComponent("documentId,title,revisionId")}`;
  const { status, json } = await call(token, url);
  return result("docs.documents.get", status, json, ["documentId", "title", "revisionId"]);
}

/**
 * Real write probe: inserts one character at the start of the body, then
 * deletes it in the same batch, so the Doc text ends unchanged (the revision
 * still advances).
 */
export async function docsWrite(token: string, docId: string): Promise<ProbeResult> {
  const url = `${DOCS}/documents/${encodeURIComponent(docId)}:batchUpdate`;
  const body = {
    requests: [
      { insertText: { location: { index: 1 }, text: "x" } },
      { deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } },
    ],
  };
  const { status, json } = await call(token, url, { method: "POST", body });
  return result("docs.documents.batchUpdate (insert+delete)", status, json, ["documentId"]);
}

/** Walk Drive parents from a file toward `rootId`; reports whether the root was reached. */
export async function walkParents(token: string, fileId: string, rootId: string): Promise<ProbeResult> {
  const chain: { id: string; status: number }[] = [];
  let current = fileId;
  for (let hop = 0; hop < MAX_PARENT_HOPS; hop += 1) {
    const url = `${DRIVE}/files/${encodeURIComponent(current)}?fields=id,parents&supportsAllDrives=true`;
    const { status, json } = await call(token, url);
    chain.push({ id: current, status });
    if (current === rootId) {
      return { probe: "parent walk to root", status: 200, ok: true, data: { reachedRoot: true, chain } };
    }
    if (status < 200 || status >= 300) break;
    const parents = (json as { parents?: unknown }).parents;
    if (!Array.isArray(parents) || typeof parents[0] !== "string") break;
    current = parents[0];
  }
  return { probe: "parent walk to root", status: 200, ok: false, data: { reachedRoot: false, chain } };
}

export async function createInDrive(
  token: string,
  kind: "folder" | "doc",
  name: string,
  parentId: string | null,
): Promise<ProbeResult> {
  const body: Record<string, unknown> = { name, mimeType: kind === "folder" ? FOLDER_MIME : DOC_MIME };
  if (parentId) body.parents = [parentId];
  const url = `${DRIVE}/files?fields=${encodeURIComponent("id,name,mimeType,parents")}&supportsAllDrives=true`;
  const { status, json } = await call(token, url, { method: "POST", body });
  return result(`drive.files.create ${kind}`, status, json, ["id", "name", "mimeType", "parents"]);
}

export async function runProbes(
  token: string,
  ids: { rootId?: string; docId?: string },
): Promise<ProbeResult[]> {
  const out: ProbeResult[] = [await whoami(token)];
  if (ids.rootId) {
    out.push(await driveGet(token, ids.rootId, "root"));
    out.push(await driveListChildren(token, ids.rootId));
  }
  if (ids.docId) {
    out.push(await driveGet(token, ids.docId, "doc"));
    out.push(await docsGet(token, ids.docId));
    if (ids.rootId) out.push(await walkParents(token, ids.docId, ids.rootId));
  }
  return out;
}
