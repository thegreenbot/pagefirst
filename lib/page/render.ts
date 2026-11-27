import { renderPage, type RenderMode, type RenderResult } from "@/lib/theme/engine";
import { getDefaultTheme } from "@/lib/theme/package";
import type { Page } from "./types";

/**
 * One render function for the editor and the publisher (PLAN.md). Markup and
 * styles come from the theme package; this module only picks the theme.
 * Until site theme config lands (#56), every page uses @pagefirst/default.
 */
export function renderPageHtml(page: Page, mode: RenderMode = "publish"): RenderResult {
  return renderPage(page, getDefaultTheme(), { mode });
}

export function renderPublishHtml(page: Page): string {
  return renderPageHtml(page, "publish").html;
}
