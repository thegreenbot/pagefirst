import type { ManifestFont } from "./manifest";
import type { ThemePackage } from "./package";

/**
 * Self-hosted theme fonts (#62). Only families that the page's resolved font
 * tokens name are shipped. Each subset is its own @font-face with its
 * unicode-range, so browsers fetch only the subsets the text uses. Each family
 * also gets a metric-adjusted local fallback face. Faces use
 * font-display:optional: with the preload the font is usually ready for first
 * paint, and when it is not the page keeps the matched fallback instead of
 * re-laying out late (a swap cost a 100 ms main-thread task under Lighthouse).
 *
 * Published renders with the server optimizer name each file by content hash
 * under assets/pf/ (served immutable); other renders, including the editor's,
 * inline them as data: URLs, so they need no route. No Node imports: the editor can render in the browser.
 */

export type FontAsset = { path: string; contentType: string; body: Uint8Array };

export type FontPlan = {
  css: string;
  assets: FontAsset[];
  /** `<link rel=preload>` hrefs (site-relative, leading slash) for fonts the theme marks preload. */
  preloads: string[];
};

const FONT_TYPE = "font/woff2";

/** A family is used when any font token value names it, quoted or not. */
export function usedFonts(fonts: ManifestFont[], tokens: Record<string, unknown>): ManifestFont[] {
  const values = Object.values(tokens).filter((value): value is string => typeof value === "string");
  return fonts.filter((font) =>
    values.some((value) => value.split(",").some((name) => name.trim().replace(/^["']|["']$/g, "") === font.family)),
  );
}

export function fallbackFamily(font: ManifestFont): string {
  return `${font.family} Fallback`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function planFonts(
  theme: ThemePackage,
  tokens: Record<string, unknown>,
  mode: "edit" | "publish",
  hash: ((text: string) => string) | undefined,
  warnings: string[],
): FontPlan {
  const css: string[] = [];
  const assets: FontAsset[] = [];
  const preloads: string[] = [];
  for (const font of usedFonts(theme.manifest.fonts ?? [], tokens)) {
    // Family names, weights, ranges and percentages were checked by parseManifest.
    const weight = font.weight ?? 400;
    const style = font.style ?? "normal";
    let shipped = 0;
    for (const file of font.files) {
      const data = theme.files?.[file.src];
      if (!data) {
        warnings.push(`Font file ${file.src} is missing from ${theme.manifest.name}`);
        continue;
      }
      let url = `data:${FONT_TYPE};base64,${data}`;
      if (mode === "publish" && hash) {
        const path = `assets/pf/${hash(data)}.woff2`;
        assets.push({ path, contentType: FONT_TYPE, body: decodeBase64(data) });
        url = `/${path}`;
        // The latin subset is what nearly every page's first paint needs.
        if (font.preload && file.subset === "latin") preloads.push(url);
      }
      shipped += 1;
      css.push(
        `@font-face{font-family:"${font.family}";font-style:${style};font-weight:${weight};font-display:optional;src:url(${url}) format("woff2");unicode-range:${file.unicodeRange}}`,
      );
    }
    if (!shipped) continue;
    const { fallback } = font;
    const metrics = [
      fallback.sizeAdjust ? `size-adjust:${fallback.sizeAdjust}` : "",
      fallback.ascentOverride ? `ascent-override:${fallback.ascentOverride}` : "",
      fallback.descentOverride ? `descent-override:${fallback.descentOverride}` : "",
      fallback.lineGapOverride ? `line-gap-override:${fallback.lineGapOverride}` : "",
    ].filter(Boolean);
    css.push(
      `@font-face{font-family:"${fallbackFamily(font)}";src:${fallback.local.map((name) => `local("${name}")`).join(",")}${metrics.length ? `;${metrics.join(";")}` : ""}}`,
    );
  }
  return { css: css.join(""), assets, preloads };
}

/** The `Link` header value that lets the site Worker hint a preloaded font with 103 Early Hints. */
export function fontLinkHeader(href: string): string {
  return `<${href}>; rel=preload; as=font; type="${FONT_TYPE}"; crossorigin`;
}
