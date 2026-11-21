import { createHash } from "node:crypto";

const PROJECT = "page-first";
const API = "https://api.cloudflare.com/client/v4";
const FALLBACK_URL = "https://page-first.pages.dev";

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

function deploymentUrl(payload: unknown): string {
  if (!payload || typeof payload !== "object") return FALLBACK_URL;
  const result = (payload as { result?: unknown }).result;
  if (!result || typeof result !== "object") return FALLBACK_URL;
  const record = result as { url?: unknown; aliases?: unknown };
  const direct = httpsUrl(record.url);
  if (direct) return direct;
  if (Array.isArray(record.aliases)) {
    const alias = httpsUrl(record.aliases[0]);
    if (alias) return alias;
  }
  return FALLBACK_URL;
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
    const createdBody = await readJson(created);
    if (
      createdBody &&
      typeof createdBody === "object" &&
      (createdBody as { success?: unknown }).success === false
    ) {
      throw failed(created.status);
    }
  } else if (!existing.ok) {
    await discard(existing);
    throw failed(existing.status);
  } else {
    await discard(existing);
  }

  const fileName = deploymentFileName(filePath);
  const fileBytes = new TextEncoder().encode(html);
  const hash = createHash("sha256").update(fileBytes).digest("hex");
  const manifest = { [`/${fileName}`]: hash };
  const form = new FormData();
  form.append("manifest", JSON.stringify(manifest));
  form.append(
    hash,
    new Blob([fileBytes], { type: "text/html; charset=utf-8" }),
    fileName,
  );

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
