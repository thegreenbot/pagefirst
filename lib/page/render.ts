import type { RenderContext } from "@/lib/site/theme-config";
import { publishedCsp } from "@/lib/theme/csp";
import { renderPage, type RenderMode, type RenderResult } from "@/lib/theme/engine";
import { getDefaultTheme } from "@/lib/theme/package";
import { withPresentation } from "@/lib/theme/presentation";
import type { Page } from "./types";

/**
 * One render function for the editor and the publisher (PLAN.md). Markup and
 * styles come from the site's locked theme package; template, section styles,
 * settings and tokens come from the app's store (#56), never from the Doc.
 */
export function renderPageHtml(page: Page, mode: RenderMode = "publish", context?: RenderContext): RenderResult {
  const theme = context?.theme ?? getDefaultTheme();
  const applied = withPresentation(page, context?.config ?? null, context?.presentation ?? null);
  return renderPage(applied.page, theme, { ...applied.options, mode, csp: publishedCsp });
}

export function renderPublishHtml(page: Page): string {
  return renderPageHtml(page, "publish").html;
}
