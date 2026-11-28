import type { DocsDocument } from "@/lib/page/types";

async function authorized(
  url: string,
  token: string,
  init: { method?: string; body?: string } = {},
): Promise<Response> {
  return fetch(url, {
    method: init.method ?? "GET",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body,
  });
}

export async function fetchDocument(token: string, fileId: string): Promise<DocsDocument> {
  const res = await authorized(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}`,
    token,
  );
  if (!res.ok) throw new Error(`Docs read failed (${res.status})`);
  return (await res.json()) as DocsDocument;
}

export async function batchUpdate(
  token: string,
  fileId: string,
  requests: object[],
): Promise<void> {
  const res = await authorized(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(fileId)}:batchUpdate`,
    token,
    { method: "POST", body: JSON.stringify({ requests }) },
  );
  if (!res.ok) throw new Error(`Docs write failed (${res.status})`);
}

export async function createDocument(token: string, title: string): Promise<DocsDocument> {
  const res = await authorized("https://docs.googleapis.com/v1/documents", token, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Docs write failed (${res.status})`);
  return (await res.json()) as DocsDocument;
}

const FOLDER_ID = /^[\w-]{10,128}$/;

/** Docs the user can see. With `folderIds`, only Docs directly inside one of those folders. */
export async function listDocuments(token: string, folderIds?: readonly string[]): Promise<{ id: string; name: string; modifiedTime?: string }[]> {
  let q = "mimeType='application/vnd.google-apps.document'";
  if (folderIds) {
    const safe = folderIds.filter((id) => FOLDER_ID.test(id));
    if (safe.length === 0) return [];
    q += ` and (${safe.map((id) => `'${id}' in parents`).join(" or ")})`;
  }
  // 100 a page, up to 5 pages: a site's whole folder in a few calls, never one call per Doc (#30).
  const files: { id?: string; name?: string; modifiedTime?: string }[] = [];
  let pageToken = "";
  for (let i = 0; i < 5; i++) {
    const res = await authorized(
      `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken%2Cfiles(id%2Cname%2CmodifiedTime)&pageSize=100&orderBy=modifiedTime%20desc${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      token,
    );
    if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
    const json = (await res.json()) as { files?: typeof files; nextPageToken?: string };
    files.push(...(json.files ?? []));
    if (!json.nextPageToken) break;
    pageToken = json.nextPageToken;
  }
  return files.flatMap((file) =>
    file.id ? [{ id: file.id, name: file.name ?? "", ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}) }] : [],
  );
}

/** The folders a file sits directly in, for site-folder allow-lists. */
export async function parentsOf(token: string, fileId: string): Promise<string[]> {
  const res = await authorized(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=parents`,
    token,
  );
  if (!res.ok) throw new Error(`Drive read failed (${res.status})`);
  const json = (await res.json()) as { parents?: string[] };
  return json.parents ?? [];
}

export type DriveMeta = {
  modifiedTime: string | null;
  /** Who last changed the file, when Drive returns it. */
  lastModifiedBy: { name: string | null; email: string | null } | null;
};

/** A Doc's last-modified time and last editor: one small Drive call, no Docs read. */
export async function driveMeta(token: string, fileId: string): Promise<DriveMeta> {
  const res = await authorized(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=modifiedTime%2ClastModifyingUser(displayName%2CemailAddress)`,
    token,
  );
  if (!res.ok) throw new Error(`Drive read failed (${res.status})`);
  const json = (await res.json()) as { modifiedTime?: string; lastModifyingUser?: { displayName?: string; emailAddress?: string } };
  const who = json.lastModifyingUser;
  return {
    modifiedTime: json.modifiedTime ?? null,
    lastModifiedBy: who ? { name: who.displayName ?? null, email: who.emailAddress ?? null } : null,
  };
}
