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

export async function listDocuments(token: string): Promise<{ id: string; name: string }[]> {
  const res = await authorized(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D%27application%2Fvnd.google-apps.document%27&fields=files(id%2Cname)&pageSize=30",
    token,
  );
  if (!res.ok) throw new Error(`Drive list failed (${res.status})`);
  const json = (await res.json()) as { files?: { id?: string; name?: string }[] };
  return (json.files ?? []).flatMap((file) =>
    file.id ? [{ id: file.id, name: file.name ?? "" }] : [],
  );
}
