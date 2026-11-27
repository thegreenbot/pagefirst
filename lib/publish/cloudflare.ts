import { createHash } from "node:crypto";

const PROJECT = "page-first";
const API = "https://api.cloudflare.com/client/v4";

function failed(status: number): Error {
  return new Error(`Cloudflare upload failed (${status})`);
}

function accountUrl(accountId: string, path: string): string {
  return `${API}/accounts/${encodeURIComponent(accountId)}${path}`;
}

function deploymentFileName(filePath: string): string {
  const slug = filePath.replace(/[/\\]/g, "-");
  if (slug === "" || slug === "index") return "index.html";
  return `${slug}.html`;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return value;
}

function deploymentUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const record = result as { url?: unknown; aliases?: unknown };
  const direct = httpsUrl(record.url);
  if (direct) return direct;
  if (Array.isArray(record.aliases)) {
    const alias = httpsUrl(record.aliases[0]);
    if (alias) return alias;
  }
  return null;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // The status is enough. The body is never copied into an error.
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Lists every page in the live deployment, so a publish can carry them forward (#85 stopgap). */
export const SITE_MANIFEST_PATH = "/_pagefirst/manifest.json";
const MAX_CARRIED_PAGES = 500;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;

type SiteFile = { path: string; bytes: Uint8Array<ArrayBuffer>; type: string };

function projectSubdomain(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return null;
  const subdomain = (result as { subdomain?: unknown }).subdomain;
  if (typeof subdomain !== "string") return null;
  return /^[a-z0-9-]+\.pages\.dev$/.test(subdomain) ? subdomain : null;
}

/**
 * Reads the live site's page list and each page's bytes. A Pages deployment
 * replaces every file, so without this one publish removes all other pages.
 * Throws when a listed page cannot be read, so a publish never silently drops one.
 */
export async function livePages(subdomain: string): Promise<SiteFile[]> {
  const listing = await fetch(`https://${subdomain}${SITE_MANIFEST_PATH}`, { cache: "no-store" });
  if (listing.status === 404) {
    await discard(listing);
    return [];
  }
  if (!listing.ok) {
    await discard(listing);
    throw new Error(`Could not read the live site (${listing.status})`);
  }
  const body = (await readJson(listing)) as { pages?: unknown } | null;
  const paths = Array.isArray(body?.pages) ? body.pages : [];
  const files: SiteFile[] = [];
  for (const path of paths.slice(0, MAX_CARRIED_PAGES)) {
    if (typeof path !== "string" || !/^\/[A-Za-z0-9._-]+\.html$/.test(path)) continue;
    const page = await fetch(`https://${subdomain}${path}`, { cache: "no-store" });
    if (!page.ok) {
      await discard(page);
      throw new Error(`Could not read live page ${path} (${page.status})`);
    }
    const bytes = new Uint8Array(await page.arrayBuffer());
    if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error(`Live page ${path} is too large to carry forward`);
    files.push({ path, bytes, type: "text/html; charset=utf-8" });
  }
  return files;
}

/** Builds the deployment form: carried pages, the new page, and an updated page list. */
export function deploymentForm(carried: SiteFile[], fileName: string, html: string): FormData {
  const files = new Map<string, SiteFile>();
  for (const file of carried) files.set(file.path, file);
  files.set(`/${fileName}`, { path: `/${fileName}`, bytes: new TextEncoder().encode(html), type: "text/html; charset=utf-8" });
  const pages = [...files.keys()].sort();
  files.set(SITE_MANIFEST_PATH, {
    path: SITE_MANIFEST_PATH,
    bytes: new TextEncoder().encode(JSON.stringify({ pages })),
    type: "application/json",
  });

  const manifest: Record<string, string> = {};
  const form = new FormData();
  const parts: [string, SiteFile][] = [];
  for (const file of files.values()) {
    const hash = createHash("sha256").update(file.bytes).digest("hex");
    manifest[file.path] = hash;
    parts.push([hash, file]);
  }
  form.append("manifest", JSON.stringify(manifest));
  const sent = new Set<string>();
  for (const [hash, file] of parts) {
    if (sent.has(hash)) continue;
    sent.add(hash);
    form.append(hash, new Blob([file.bytes], { type: file.type }), file.path.split("/").pop());
  }
  return form;
}

export async function uploadToCloudflare(
  filePath: string,
  html: string,
): Promise<string | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !account) return null;

  const authorization = `Bearer ${token}`;
  const projectUrl = accountUrl(account, `/pages/projects/${PROJECT}`);
  const existing = await fetch(projectUrl, {
    method: "GET",
    cache: "no-store",
    headers: { Authorization: authorization },
  });

  let project: unknown = null;
  if (existing.status === 404) {
    await discard(existing);
    const created = await fetch(accountUrl(account, "/pages/projects"), {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: PROJECT, production_branch: "main" }),
    });
    if (!created.ok) {
      await discard(created);
      throw failed(created.status);
    }
    project = await readJson(created);
    if (project && typeof project === "object" && (project as { success?: unknown }).success === false) {
      throw failed(created.status);
    }
  } else if (!existing.ok) {
    await discard(existing);
    throw failed(existing.status);
  } else {
    project = await readJson(existing);
  }

  const subdomain = projectSubdomain(project);
  const carried = subdomain ? await livePages(subdomain) : [];
  const form = deploymentForm(carried, deploymentFileName(filePath), html);

  const deployed = await fetch(`${projectUrl}/deployments`, {
    method: "POST",
    cache: "no-store",
    headers: { Authorization: authorization },
    body: form,
  });

  if (!deployed.ok) {
    await discard(deployed);
    throw failed(deployed.status);
  }

  const payload = await readJson(deployed);
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { success?: unknown }).success === false
  ) {
    throw failed(deployed.status);
  }
  return deploymentUrl(payload);
}
