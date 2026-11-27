import type { Page } from "@/lib/page/types";
import type { PagePresentation, SiteThemeConfig } from "@/lib/site/theme-config";
import type { RenderOptions } from "./engine";

/**
 * Applies a site's stored presentation to a page before rendering (#56).
 * Browser-safe, so the editor preview and publish agree.
 *
 * With a stored config, section styles come only from the app, never from the
 * Doc. Without one (no database, sample mode), the Doc's own section styles
 * are kept, as before #56.
 */
export function withPresentation(
  page: Page,
  config: (Pick<SiteThemeConfig, "settings" | "tokens"> & { customCss?: string }) | null,
  presentation: PagePresentation | null,
): { page: Page; options: Pick<RenderOptions, "template" | "settings" | "tokens" | "customCss"> } {
  if (!config) return { page, options: {} };
  const styles = presentation?.sectionStyles ?? {};
  return {
    page: {
      ...page,
      sections: page.sections.map((section) => ({
        ...section,
        style: Object.hasOwn(styles, section.id) ? [...styles[section.id]] : [],
      })),
    },
    options: {
      template: presentation?.template ?? "page",
      settings: config.settings,
      tokens: config.tokens,
      customCss: config.customCss,
    },
  };
}
