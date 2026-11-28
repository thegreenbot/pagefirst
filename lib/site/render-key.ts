import { createHash } from "node:crypto";
import { query } from "@/lib/db/client";
import type { RenderContext } from "./theme-config";

/**
 * Rendering is a pure function of a page revision, the theme version and the
 * site config (#67), so each output has a key: hash(revisionId + themeIntegrity
 * + siteConfigHash). A page already published under the same key is not
 * rendered or uploaded again.
 */

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const sorted = (record: Record<string, unknown>) => Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Everything in the render context that changes the bytes: config, and the page's presentation. */
export function siteConfigHash(context: Pick<RenderContext, "config" | "presentation" | "beacon">): string {
  const { config, presentation, beacon } = context;
  return sha(
    JSON.stringify([
      config
        ? [config.themeName, config.versionRange, sorted(config.tokens), sorted(config.settings), config.customCss, sorted(config.templateOverrides), [...config.locks].sort()]
        : null,
      presentation ? [presentation.template, sorted(presentation.sectionStyles)] : null,
      beacon ? [beacon.endpoint, beacon.site] : null,
    ]),
  );
}

export function renderKey(revisionId: string, context: RenderContext): string {
  return sha([revisionId, context.config?.lock.integrity ?? context.theme.manifest.name + "@" + context.theme.manifest.version, siteConfigHash(context)].join("\0"));
}

/** True when the page's latest public publish used this exact key. */
export async function isCurrentRender(siteId: string, fileId: string, key: string): Promise<boolean> {
  const rows = await query<{ render_key: string | null }>("SELECT render_key FROM site_pages WHERE site_id = $1 AND file_id = $2", [siteId, fileId]);
  return rows[0]?.render_key === key;
}

export async function recordRenderKey(siteId: string, fileId: string, key: string): Promise<void> {
  await query("UPDATE site_pages SET render_key = $3 WHERE site_id = $1 AND file_id = $2", [siteId, fileId, key]);
}
