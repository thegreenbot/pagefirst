import { fetchGoogleIdentity } from "@/lib/google/userinfo";
import type { PublishResult } from "@/lib/page/types";
import { renderPageHtml } from "@/lib/page/render";
import { mayPublishPublicly } from "@/lib/publish/allowlist";
import { uploadToCloudflare } from "@/lib/publish/cloudflare";
import { encodeMissing, planImages, recordSiteRenditions, siteHasRenditions } from "@/lib/publish/images";
import { readPreviewAsset, savePreview, savePreviewAssets } from "@/lib/publish/preview";
import { publishToOwnSite, sitePublishingEnabled } from "@/lib/publish/sites";
import { renderContextFor, siteForOwner } from "@/lib/site/theme-config";
import { recordSitePage } from "@/lib/site/theme-preview";
import { requireScope, ServiceError, type ServiceContext } from "./context";
import { getPage } from "./pages";

export type PublishResponse = PublishResult & { warning?: string };

export type PublishOptions = {
  /** Publish a copy to the site's public address, not only a preview. */
  public?: boolean;
  /** Refuse unless the Doc is still at this revision. */
  revisionId?: string;
};

/** What an adapter records in the audit log for this call. */
export type PublishAudit = {
  outcome: "ok" | "denied" | "error";
  errorCode: string | null;
  siteId: string | null;
  resultRevisionId: string;
  pagePath: string | null;
};

export type PublishOutcome = { response: PublishResponse; audit: PublishAudit };

/**
 * Renders a page and stores a preview, then optionally publishes it. Throws
 * `not_found` for an unknown page, `conflict` when `revisionId` is stale and
 * `forbidden` when the credential lacks the scope.
 */
export async function publish(ctx: ServiceContext, fileId: string, options: PublishOptions = {}): Promise<PublishOutcome> {
  const wantsPublic = options.public === true;
  // A preview only reads; a public copy is its own scope, never implied by commit.
  requireScope(ctx, wantsPublic ? "pages:publish" : "pages:read");

  const payload = await getPage({ ...ctx, scopes: undefined }, fileId);
  if (!payload) throw new ServiceError("not_found", "Page not found");
  if (options.revisionId && payload.page.revisionId !== options.revisionId) {
    throw new ServiceError("conflict", "This doc changed since that revision.", { page: payload.page });
  }

  // Sample pages have no site; signed-in pages render with their site's stored theme (#56).
  const renderContext = await renderContextFor(payload.sample ? null : ctx.actor.sub, fileId);
  // Image renditions (#61): planned once, encoded only for destinations that lack them.
  const imagePlan = await planImages(payload.page);
  const { html, csp, assets, preloads } = renderPageHtml(payload.page, "publish", renderContext, imagePlan.images);
  const previewImages = await encodeMissing(imagePlan.planned, (image) => image.paths.every((path) => readPreviewAsset(path) !== null));
  // Preview assets stay in this instance's memory; public publishing uploads them with the page.
  savePreviewAssets([...assets, ...previewImages.assets]);
  await savePreview(fileId, html, csp, payload.page.revisionId);

  const response: PublishResponse = { ok: true, sample: payload.sample, previewPath: `/published/${fileId}` };
  const audit = (outcome: PublishAudit["outcome"], errorCode: string | null, siteId: string | null = null): PublishOutcome => ({
    response,
    audit: {
      outcome,
      errorCode,
      siteId,
      resultRevisionId: payload.page.revisionId,
      pagePath: wantsPublic ? payload.page.path : null,
    },
  });

  if (!wantsPublic) return audit("ok", "preview");

  if (!ctx.googleToken) {
    response.warning = "Sign in with Google before publishing a public copy.";
    return audit("denied", "public:signed_out");
  }

  if (sitePublishingEnabled()) {
    // Each account publishes to its own site (#94), so no allow-list is needed.
    if (!ctx.actor.sub || payload.sample) {
      response.warning = "Sign in with Google before publishing a public copy.";
      return audit("denied", "public:no_account");
    }
    try {
      const siteId = await siteForOwner(ctx.actor.sub);
      const uploaded = await siteHasRenditions(siteId, imagePlan.planned.map((image) => image.hash));
      const siteImages = await encodeMissing(imagePlan.planned, (image) => uploaded.has(image.hash));
      const published = await publishToOwnSite(ctx.actor.sub, payload.page.path, { html, csp, preloads, assets: [...assets, ...siteImages.assets] });
      await recordSiteRenditions(published.siteId, siteImages.encoded);
      // Theme change previews sample these pages, and applying one republishes them (#66).
      await recordSitePage(published.siteId, { fileId, path: payload.page.path, revisionId: payload.page.revisionId });
      response.url = published.url;
      return audit("ok", "public", published.siteId);
    } catch (error) {
      response.warning = error instanceof Error ? error.message : "Publishing failed";
      return audit("error", "public:upload_failed");
    }
  }

  // Stopgap until R2 is configured: one shared Pages project, allow-listed accounts only (#85).
  const identity = await fetchGoogleIdentity(ctx.googleToken);
  if (!mayPublishPublicly(identity?.email ?? null)) {
    response.warning = "Public publishing is limited to approved accounts for now. Your preview is ready.";
    return audit("denied", "public:not_allowed");
  }

  try {
    const url = await uploadToCloudflare(payload.page.path, html);
    if (url) response.url = url;
    else response.warning = "Cloudflare did not return a page address.";
  } catch (error) {
    response.warning = error instanceof Error ? error.message : "Cloudflare upload failed";
  }
  return audit(response.url ? "ok" : "error", response.url ? "public" : "public:upload_failed");
}

