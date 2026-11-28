import { Liquid, Tag, Value, type Context, type Emitter, type TagToken, type TopLevelToken } from "liquidjs";
import type { Block, Page, Prose } from "@/lib/page/types";
import { CRITICAL_CSS_BUDGET_BYTES, minifyCss, pruneUnusedOptions } from "./css";
import { beaconScript, type Beacon } from "./beacon";
import { ISLAND_CSS, ISLAND_LOADER, JS_BUDGET_BYTES } from "./islands";
import type { BlockLoad } from "./manifest";
import type { ThemePackage } from "./package";
import { fontLinkHeader, planFonts } from "./fonts";
import { resolveTokens, tokensCss } from "./tokens";

/**
 * The theme engine (docs/adr/0002-theme-package-contract.md). Renders a Page
 * with a theme package through a sandboxed LiquidJS instance. Templates get
 * read-only views of the page; only the engine's own tags emit markup.
 */

export type RenderMode = "edit" | "publish";

export type RenderOptions = {
  mode?: RenderMode;
  /** Opt-in field speed beacon (#70), published renders only. Without it the page ships no script of its own. */
  beacon?: Beacon;
  template?: string;
  site?: { name?: string; url?: string; lang?: string };
  settings?: Record<string, unknown>;
  /** The site's token values, over the theme's defaults (#56, #57). */
  tokens?: Record<string, unknown>;
  /**
   * The site's own CSS (#65, paid plans on the hosted service). It renders in
   * the last cascade layer, so it wins over the theme and blocks, and always
   * ships inline with the critical CSS.
   */
  customCss?: string;
  /**
   * Replacement Liquid sources for the locked theme's own templates, by path
   * such as "partials/footer" (#65). Paths the theme version does not have are
   * skipped with a warning, so an override never outlives the template it replaced.
   */
  templateOverrides?: Record<string, string>;
  /**
   * Builds the page's CSP from the exact text of each <style> element, written
   * into a <meta> tag. Server renders pass publishedCsp (lib/theme/csp.ts); the engine
   * itself has no Node imports so the editor can render in the browser.
   */
  csp?: (styleTexts: string[], extra: CspExtra) => string;
  /**
   * Server-side helpers for splitting CSS (#59) and naming island modules (#60).
   * Without them, or in edit mode, all of the page's CSS is inlined and no
   * JavaScript ships.
   */
  optimizer?: { gzipSize: (text: string) => number; hash: (text: string) => string };
  /**
   * Published image renditions by Drive file id (#61). When given, a published
   * image renders as <picture> with AVIF and WebP srcsets and its dimensions,
   * and an image without a rendition is left out with a warning, so a published
   * page never points at /api/media. Without it, images use /api/media.
   */
  images?: Record<string, ImageRendition>;
};

/** Renditions of one image, from lib/publish/images.ts. Paths are site-relative, without a leading slash. */
export type ImageRendition = {
  width: number;
  height: number;
  avif: { path: string; width: number }[];
  webp: { path: string; width: number }[];
};

/**
 * A Link header preloading the LCP image's AVIF renditions (every browser that
 * reads imagesrcset decodes AVIF), so the picture's <source> uses the same file.
 */
function imagePreload(rendition: ImageRendition): string {
  const list = rendition.avif.length ? rendition.avif : rendition.webp;
  const type = rendition.avif.length ? "image/avif" : "image/webp";
  const srcset = list.map((r) => `/${r.path} ${r.width}w`).join(", ");
  return `</${list[list.length - 1].path}>; rel=preload; as=image; type="${type}"; imagesrcset="${srcset}"; imagesizes="${IMAGE_SIZES}"; fetchpriority=high`;
}

/** Images fill their container's width at most; this keeps phones off the large files. */
const IMAGE_SIZES = "(min-width: 1440px) 1440px, 100vw";

/** A text file the engine writes: deferred CSS (#59) and island modules (#60). */
type TextAsset = { path: string; contentType: string; body: string };

/** A file the page references, to be served or uploaded next to it: text, or a font (#62). */
export type RenderAsset = { path: string; contentType: string; body: string | Uint8Array };

/** A file published next to a page: text assets from the engine, binary image renditions (#61). */
export type PublishAsset = { path: string; contentType: string; body: string | Uint8Array };

/** What the page needs beyond its own styles, for the CSP builder. */
export type CspExtra = {
  selfStyles: boolean;
  scripts: string[];
  /** Origins the theme declares in theme.json `permissions` (#63). */
  permissions: { connect: string[]; img: string[]; frame: string[] };
};

export type RenderResult = {
  html: string;
  /** The CSP written into the page, or "" when no csp builder was given. */
  csp: string;
  warnings: string[];
  assets: RenderAsset[];
  /**
   * `Link` header values for what the page needs first: the LCP image (#63).
   * The site Worker sends them so Cloudflare can answer with 103 Early Hints.
   */
  preloads: string[];
};

const LIMITS = {
  parseLimit: 1_000_000,
  renderLimit: 500,
  memoryLimit: 10_000_000,
  outputBytes: 2_000_000,
};

type ProseView = {
  kind: "prose";
  id: string;
  tag: Prose["tag"];
  text: string;
  items: string[];
  image: { alt: string } | null;
};

type CellView = { id: string; children: ProseView[] };

type BlockView = {
  kind: "block";
  id: string;
  name: string;
  options: string[];
  rows: CellView[][];
  index: number;
  section: number;
  aboveFold: boolean;
  declared: boolean;
};

type SectionView = { id: string; style: string[]; index: number; children: (ProseView | BlockView)[] };

type RenderState = {
  mode: RenderMode;
  /** Pre-rendered markup for every node view, written by {% pf_node %}. */
  html: WeakMap<object, string>;
  head: string;
  foot: string;
  footUsed: boolean;
  /** The block whose template is rendering, for {% island %}. */
  block: BlockView | null;
  /** Module asset per block name that may mount as an island on this page. */
  modules: Map<string, { asset: TextAsset; load: BlockLoad }>;
  /** Blocks that mounted an island, with whether one is in the first section. */
  islands: Map<string, { firstSection: boolean }>;
};

const STATE = Symbol("pagefirst.render");

function state(ctx: Context): RenderState {
  const value = (ctx.globals as Record<symbol, unknown>)[STATE];
  if (!value) throw new Error("pagefirst tags can only run inside the theme engine");
  return value as RenderState;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function idAttribute(mode: RenderMode, id: unknown): string {
  if (mode !== "edit" || typeof id !== "string" || !id) return "";
  return ` data-pf-id="${escapeHtml(id)}"`;
}

/** A tag with one expression argument, e.g. {% pf_id node %}. */
abstract class ArgumentTag extends Tag {
  private value: Value;
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    this.value = new Value(token.args, liquid);
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const arg = yield this.value.value(ctx, false);
    emitter.write(this.output(state(ctx), arg));
  }
  abstract output(state: RenderState, arg: unknown): string;
}

class PfIdTag extends ArgumentTag {
  output(s: RenderState, arg: unknown): string {
    return idAttribute(s.mode, (arg as { id?: unknown } | null)?.id);
  }
}

class PfNodeTag extends ArgumentTag {
  output(s: RenderState, arg: unknown): string {
    return typeof arg === "object" && arg !== null ? (s.html.get(arg) ?? "") : "";
  }
}

/** {% image node %}: same markup as an image paragraph, for use inside block templates. */
class ImageTag extends PfNodeTag {}

class PfHeadTag extends Tag {
  render(ctx: Context, emitter: Emitter): void {
    emitter.write(state(ctx).head);
  }
}

/** {% pf_foot %}: just before </body>. Deferred CSS (#59) and the island loader (#60). */
class PfFootTag extends Tag {
  render(ctx: Context, emitter: Emitter): void {
    const s = state(ctx);
    s.footUsed = true;
    emitter.write(s.foot);
  }
}

/**
 * {% island %}…{% endisland %} marks where a block's JS mounts (#60). On a
 * published page, inside a block that ships a module, the body is wrapped in
 * <pf-island>; everywhere else (the editor, layouts, blocks without JS) it
 * renders just its body.
 */
class IslandTag extends Tag {
  private body: ReturnType<Liquid["parser"]["parseTokens"]> = [];
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    const stream = liquid.parser.parseStream(remain);
    stream
      .on("tag:endisland", () => stream.stop())
      .on("template", (tpl: (typeof this.body)[number]) => this.body.push(tpl))
      .on("end", () => {
        throw new Error(`tag ${token.getText()} not closed`);
      });
    stream.start();
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const s = state(ctx);
    const block = s.block;
    const islandModule = block ? s.modules.get(block.name) : undefined;
    if (!block || !islandModule) {
      yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
      return;
    }
    const seen = s.islands.get(block.name);
    s.islands.set(block.name, { firstSection: (seen?.firstSection ?? false) || block.section === 0 });
    emitter.write(`<pf-island data-pf-src="/${escapeHtml(islandModule.asset.path)}" data-pf-load="${islandModule.load}">`);
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
    emitter.write("</pf-island>");
  }
}

class DisabledTag extends Tag {
  constructor(token: TagToken, remain: TopLevelToken[], liquid: Liquid) {
    super(token, remain, liquid);
    throw new Error(`{% ${token.name} %} is not available in themes; use {% render %} with a partial`);
  }
  render(): void {}
}

function classes(tokens: unknown, ...leading: unknown[]): string {
  const list = [...leading, ...(Array.isArray(tokens) ? tokens : [tokens])];
  return list
    .filter((token): token is string => typeof token === "string")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(" ");
}

const engines = new WeakMap<ThemePackage, Liquid>();

function engineFor(theme: ThemePackage, overrides?: Record<string, string>): Liquid {
  const custom = overrides && Object.keys(overrides).length > 0;
  let liquid = custom ? undefined : engines.get(theme);
  if (liquid) return liquid;
  const templates: Record<string, string> = {};
  for (const [name, source] of Object.entries(theme.templates)) templates[`${name}.liquid`] = overrides && Object.hasOwn(overrides, name) ? overrides[name] : source;
  liquid = new Liquid({
    templates,
    extname: ".liquid",
    cache: true,
    outputEscape: "escape",
    strictFilters: true,
    ownPropertyOnly: true,
    parseLimit: LIMITS.parseLimit,
    renderLimit: LIMITS.renderLimit,
    memoryLimit: LIMITS.memoryLimit,
  });
  liquid.registerTag("pf_head", PfHeadTag);
  liquid.registerTag("pf_foot", PfFootTag);
  liquid.registerTag("pf_node", PfNodeTag);
  liquid.registerTag("pf_id", PfIdTag);
  liquid.registerTag("image", ImageTag);
  liquid.registerTag("island", IslandTag);
  liquid.registerTag("include", DisabledTag);
  liquid.registerTag("layout", DisabledTag);
  liquid.registerFilter("classes", classes);
  liquid.registerFilter("raw", () => {
    throw new Error("the raw filter is not available in themes");
  });
  if (!custom) engines.set(theme, liquid);
  return liquid;
}

function pageTitle(page: Page): string {
  if (page.metadata.title) return page.metadata.title;
  for (const section of page.sections) {
    for (const child of section.children) {
      if (child.kind === "prose" && child.tag === "h1" && child.text) return child.text;
      if (child.kind === "block") {
        for (const row of child.rows) {
          for (const cell of row) {
            for (const prose of cell.children) {
              if (prose.tag === "h1" && prose.text) return prose.text;
            }
          }
        }
      }
    }
  }
  return page.path;
}

function proseView(node: Prose): ProseView {
  return {
    kind: "prose",
    id: node.id,
    tag: node.tag,
    text: node.text ?? "",
    items: [...(node.items ?? [])],
    image: node.image ? { alt: node.image.alt } : null,
  };
}

/** Built-in prose markup. Images get eager loading only when they are the LCP candidate. */
function renderProse(node: Prose, mode: RenderMode, lcp: boolean, images: RenderOptions["images"], warnings: string[]): string {
  const id = idAttribute(mode, node.id);
  if (node.tag === "img") {
    const driveFileId = node.image?.driveFileId ?? "";
    if (!driveFileId) return "";
    const alt = escapeHtml(node.image?.alt ?? "");
    const loading = lcp ? ` fetchpriority="high"` : ` loading="lazy" decoding="async"`;
    if (mode === "publish" && images) {
      const rendition = Object.hasOwn(images, driveFileId) ? images[driveFileId] : null;
      if (!rendition || !rendition.webp.length) {
        warnings.push(`Image "${node.image?.alt || driveFileId}" could not be prepared for publishing and was left out`);
        return "";
      }
      const srcset = (list: ImageRendition["webp"]) => list.map((r) => `/${escapeHtml(r.path)} ${r.width}w`).join(", ");
      const largest = rendition.webp[rendition.webp.length - 1];
      const avif = rendition.avif.length ? `<source type="image/avif" srcset="${srcset(rendition.avif)}" sizes="${IMAGE_SIZES}">` : "";
      return `<picture>${avif}<img src="/${escapeHtml(largest.path)}" srcset="${srcset(rendition.webp)}" sizes="${IMAGE_SIZES}" width="${rendition.width}" height="${rendition.height}" alt="${alt}"${loading}></picture>`;
    }
    return `<img src="/api/media/${escapeHtml(driveFileId)}" alt="${alt}"${loading}${id}>`;
  }
  if (node.tag === "ul" || node.tag === "ol") {
    const items = (node.items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<${node.tag}${id}>${items}</${node.tag}>`;
  }
  const tag = node.tag === "h1" || node.tag === "h2" || node.tag === "h3" || node.tag === "h4" ? node.tag : "p";
  return `<${tag}${id}>${escapeHtml(node.text ?? "")}</${tag}>`;
}

/** Markup for a block the theme does not declare: the plain EDS shape. */
function fallbackBlock(view: BlockView, mode: RenderMode, html: WeakMap<object, string>): string {
  const cells = view.rows
    .flat()
    .map((cell) => `<div>${cell.children.map((child) => html.get(child) ?? "").join("")}</div>`)
    .join("");
  return `<div class="${escapeHtml(classes(view.options, view.name))}"${idAttribute(mode, view.id)}>${cells}</div>`;
}

function settingDefaults(theme: ThemePackage): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const setting of theme.manifest.settings ?? []) {
    if (setting.default !== undefined) out[setting.id] = setting.default;
  }
  return out;
}

/**
 * Base CSS plus the CSS of blocks on the page, minified, without selectors for
 * declared options the page does not use. Inlined whole when it fits the
 * critical budget; otherwise base and first-section blocks are inlined and the
 * rest is one content-addressed file shared by pages with the same block set.
 */
function planCss(
  theme: ThemePackage,
  usedBlocks: Set<string>,
  usedOptions: Map<string, Set<string>>,
  firstSection: Set<string>,
  optimizer: RenderOptions["optimizer"],
  tokens: string,
  customCss: string,
): { critical: string; deferred: TextAsset | null } {
  const unused: Record<string, string[]> = {};
  for (const name of usedBlocks) {
    const declared = theme.manifest.blocks[name]?.options ?? [];
    const seen = usedOptions.get(name) ?? new Set<string>();
    unused[name] = declared.filter((option) => !seen.has(option));
  }
  const prepare = (source: string) => pruneUnusedOptions(minifyCss(source), unused);
  const base = prepare(theme.baseCss);
  const blocks = Object.keys(theme.manifest.blocks)
    .filter((name) => usedBlocks.has(name))
    .map((name) => ({ name, css: prepare(theme.blockCss[name] ?? "") }));
  // Layers fix precedence whatever order the CSS arrives in (tokens < theme < blocks < customer).
  const layer = (name: string, css: string) => (css ? `@layer ${name}{${css}}` : "");
  const themeCss = layer("theme", base);
  const customer = layer("customer", customCss);
  const all = themeCss + layer("blocks", blocks.map((block) => block.css).join("")) + customer;
  if (!optimizer || optimizer.gzipSize(tokens + all) <= CRITICAL_CSS_BUDGET_BYTES) return { critical: all, deferred: null };

  const critical = themeCss + layer("blocks", blocks.filter((block) => firstSection.has(block.name)).map((block) => block.css).join("")) + customer;
  const rest = layer("blocks", blocks.filter((block) => !firstSection.has(block.name)).map((block) => block.css).join(""));
  if (!rest) return { critical, deferred: null };
  return {
    critical,
    deferred: { path: `assets/pf/${optimizer.hash(rest)}.css`, contentType: "text/css; charset=utf-8", body: rest },
  };
}

export function renderPage(page: Page, theme: ThemePackage, options: RenderOptions = {}): RenderResult {
  const mode = options.mode ?? "publish";
  const template = options.template ?? "page";
  const { manifest } = theme;
  if (!Object.hasOwn(manifest.templates, template)) {
    throw new Error(`${manifest.name} has no "${template}" template`);
  }
  const warnings: string[] = [];
  const overrides: Record<string, string> = {};
  for (const [name, source] of Object.entries(options.templateOverrides ?? {})) {
    if (Object.hasOwn(theme.templates, name)) overrides[name] = source;
    else warnings.push(`Template override "${name}" skipped: ${manifest.name} ${manifest.version} has no such template`);
  }
  const liquid = engineFor(theme, overrides);
  const html = new WeakMap<object, string>();
  const blocks: { view: BlockView }[] = [];
  const usedBlocks = new Set<string>();
  const usedOptions = new Map<string, Set<string>>();
  const firstSectionBlocks = new Set<string>();
  let lcpTaken = false;
  const linkPreloads: string[] = [];

  const prose = (node: Prose, sectionIndex: number): ProseView => {
    const view = proseView(node);
    const lcp = node.tag === "img" && !!node.image?.driveFileId && sectionIndex === 0 && !lcpTaken;
    if (lcp) lcpTaken = true;
    const rendition = lcp && mode === "publish" && options.images ? options.images[node.image!.driveFileId] : undefined;
    if (rendition) linkPreloads.push(imagePreload(rendition));
    html.set(view, renderProse(node, mode, lcp, options.images, warnings));
    return view;
  };

  const blockView = (node: Block, sectionIndex: number, index: number): BlockView => {
    const declared = Object.hasOwn(manifest.blocks, node.name) ? manifest.blocks[node.name] : null;
    let options = [...node.options];
    if (declared) {
      const allowed = new Set(declared.options ?? []);
      const dropped = options.filter((option) => !allowed.has(option));
      if (dropped.length) warnings.push(`Block "${node.name}" does not support ${dropped.map((o) => `"${o}"`).join(", ")}`);
      options = options.filter((option) => allowed.has(option));
      usedBlocks.add(node.name);
      if (sectionIndex === 0) firstSectionBlocks.add(node.name);
      const seen = usedOptions.get(node.name) ?? new Set<string>();
      for (const option of options) seen.add(option);
      usedOptions.set(node.name, seen);
    } else {
      warnings.push(`Block "${node.name}" is not in ${manifest.name}; it renders with plain markup`);
    }
    const view: BlockView = {
      kind: "block",
      id: node.id,
      name: node.name,
      options,
      rows: node.rows.map((row) => row.map((cell) => ({ id: cell.id, children: cell.children.map((c) => prose(c, sectionIndex)) }))),
      index,
      section: sectionIndex,
      aboveFold: sectionIndex === 0,
      declared: !!declared,
    };
    blocks.push({ view });
    return view;
  };

  const sections: SectionView[] = page.sections.map((section, sectionIndex) => ({
    id: section.id,
    style: [...section.style],
    index: sectionIndex,
    children: section.children.map((child, index) =>
      child.kind === "prose" ? prose(child, sectionIndex) : blockView(child, sectionIndex, index),
    ),
  }));

  const title = pageTitle(page);
  const pageView = {
    title,
    description: page.metadata.description ?? "",
    path: page.path,
    template,
    sections,
  };
  const resolvedTokens = resolveTokens(theme, options.tokens ?? {});
  const tokenStyle = tokensCss(resolvedTokens);
  const scope = {
    page: pageView,
    site: { name: options.site?.name ?? "", url: options.site?.url ?? "", lang: options.site?.lang || "en" },
    theme: {
      name: manifest.name,
      version: manifest.version,
      tokens: resolvedTokens,
      settings: { ...settingDefaults(theme), ...(options.settings ?? {}) },
    },
    mode,
  };

  const optimizer = mode === "edit" ? undefined : options.optimizer;
  const renderState: RenderState = {
    mode,
    html,
    head: "",
    foot: "",
    footUsed: false,
    block: null,
    modules: islandModules(theme, usedBlocks, mode, optimizer, warnings),
    islands: new Map(),
  };
  const globals = { [STATE]: renderState };

  // Blocks render first, so the head knows which islands the page mounts.
  for (const { view } of blocks) {
    if (!view.declared) {
      html.set(view, fallbackBlock(view, mode, html));
      continue;
    }
    renderState.block = view;
    const out = liquid.renderFileSync(`blocks/${view.name}/block`, { ...scope, block: view }, { globals });
    html.set(view, String(out));
  }
  renderState.block = null;
  for (const name of renderState.modules.keys()) {
    if (!renderState.islands.has(name)) warnings.push(`Block "${name}" ships JavaScript but its template has no {% island %}; it was not loaded`);
  }
  const islandAssets = [...renderState.islands.keys()].map((name) => renderState.modules.get(name)!.asset);
  if (optimizer && islandAssets.length) {
    const budget = Math.floor((manifest.budgets?.jsKb ?? JS_BUDGET_BYTES / 1024) * 1024);
    const size = islandAssets.reduce((total, asset) => total + optimizer.gzipSize(asset.body), 0);
    if (size > budget) warnings.push(`Island JavaScript is ${size} bytes compressed, over the ${budget} byte budget`);
  }
  const hasIslands = islandAssets.length > 0;

  const fonts = planFonts(theme, resolvedTokens, mode, optimizer?.hash, warnings);
  const customCss = options.customCss?.trim() ? minifyCss(options.customCss) : "";
  const css = planCss(theme, usedBlocks, usedOptions, firstSectionBlocks, optimizer, tokenStyle, customCss);
  if (optimizer && customCss) {
    const without = planCss(theme, usedBlocks, usedOptions, firstSectionBlocks, optimizer, tokenStyle, "").critical;
    const over = optimizer.gzipSize(tokenStyle + css.critical) - CRITICAL_CSS_BUDGET_BYTES;
    if (over > 0 && optimizer.gzipSize(tokenStyle + without) <= CRITICAL_CSS_BUDGET_BYTES) {
      warnings.push(`Custom CSS pushed the critical CSS ${over} bytes over its ${CRITICAL_CSS_BUDGET_BYTES} byte budget; shorten it`);
    } else if (over > 0) {
      warnings.push(`Critical CSS is ${over} bytes over its ${CRITICAL_CSS_BUDGET_BYTES} byte budget, including ${optimizer.gzipSize(customCss)} bytes of custom CSS`);
    }
  }
  const beacon = mode === "publish" && options.beacon ? beaconScript(options.beacon) : "";
  let beaconOrigin = "";
  if (beacon) {
    try {
      beaconOrigin = new URL(options.beacon!.endpoint).origin;
    } catch {
      warnings.push("The speed beacon endpoint is not a valid URL; the beacon was left out");
    }
  }
  const criticalCss = fonts.css + (hasIslands ? ISLAND_CSS : "") + css.critical;
  const csp = options.csp
    ? options.csp([tokenStyle, criticalCss], {
        selfStyles: !!css.deferred,
        scripts: [...(hasIslands ? [ISLAND_LOADER] : []), ...(beaconOrigin ? [beacon] : [])],
        permissions: {
          connect: [...(manifest.permissions?.connect ?? []), ...(beaconOrigin ? [beaconOrigin] : [])],
          img: [...(manifest.permissions?.img ?? [])],
          frame: [...(manifest.permissions?.frame ?? [])],
        },
      })
    : "";
  const cspMeta = csp ? `\n<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` : "";
  const description = pageView.description
    ? `\n<meta name="description" content="${escapeHtml(pageView.description)}">`
    : "";
  // Only islands in the first section are worth fetching before they are needed.
  const preloads = [...renderState.islands]
    .filter(([, island]) => island.firstSection)
    .map(([name]) => `\n<link rel="modulepreload" href="/${renderState.modules.get(name)!.asset.path}">`)
    .join("");
  const fontPreloads = fonts.preloads.map((href) => `\n<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`).join("");
  linkPreloads.push(...fonts.preloads.map(fontLinkHeader));
  renderState.head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${cspMeta}
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title>${description}
<style data-pf-tokens>${tokenStyle}</style>
<style>${criticalCss}</style>${fontPreloads}${preloads}`;
  const foot = [
    css.deferred ? `<link rel="stylesheet" href="/${css.deferred.path}">` : "",
    hasIslands ? `<script>${ISLAND_LOADER}</script>` : "",
    beaconOrigin ? `<script>${beacon}</script>` : "",
  ]
    .filter(Boolean)
    .join("\n");
  renderState.foot = foot;

  // Blocks were rendered in document order; a block never contains another block.
  let out = String(liquid.renderFileSync(`layouts/${template}`, scope, { globals }));
  if (foot && !renderState.footUsed) {
    // The layout has no {% pf_foot %}; put it before the last </body>, or at the end.
    const at = out.lastIndexOf("</body>");
    out = at === -1 ? `${out}${foot}` : `${out.slice(0, at)}${foot}\n${out.slice(at)}`;
  }
  if (out.length > LIMITS.outputBytes) throw new Error(`${manifest.name}: page output exceeds ${LIMITS.outputBytes} bytes`);
  const assets: RenderAsset[] = [...(css.deferred ? [css.deferred] : []), ...islandAssets, ...fonts.assets];
  return { html: out, csp, warnings, assets, preloads: linkPreloads };
}

/**
 * One content-addressed module per block on the page that ships JS. Only
 * published renders with the server optimizer ship JS; the editor never does.
 */
function islandModules(
  theme: ThemePackage,
  usedBlocks: Set<string>,
  mode: RenderMode,
  optimizer: RenderOptions["optimizer"],
  warnings: string[],
): RenderState["modules"] {
  const modules: RenderState["modules"] = new Map();
  if (mode !== "publish") return modules;
  for (const name of usedBlocks) {
    const load = theme.manifest.blocks[name]?.js?.load;
    const source = theme.blockJs?.[name];
    if (!load || !source) continue;
    if (!optimizer) {
      warnings.push(`Block "${name}" JavaScript was left out: this render has no optimizer to name its module`);
      continue;
    }
    modules.set(name, {
      load,
      asset: { path: `assets/pf/${optimizer.hash(source)}.js`, contentType: "text/javascript; charset=utf-8", body: source },
    });
  }
  return modules;
}
