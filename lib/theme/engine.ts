import { Liquid, Tag, Value, type Context, type Emitter, type TagToken, type TopLevelToken } from "liquidjs";
import type { Block, Page, Prose } from "@/lib/page/types";
import type { ThemePackage } from "./package";

/**
 * The theme engine (docs/adr/0001-theme-package-contract.md). Renders a Page
 * with a theme package through a sandboxed LiquidJS instance. Templates get
 * read-only views of the page; only the engine's own tags emit markup.
 */

export type RenderMode = "edit" | "publish";

export type RenderOptions = {
  mode?: RenderMode;
  template?: string;
  site?: { name?: string; url?: string; lang?: string };
  settings?: Record<string, unknown>;
  /** The site's token values, over the theme's defaults (#56, #57). */
  tokens?: Record<string, unknown>;
  /**
   * Builds the page's CSP from the exact <style> text, which is written into a
   * <meta> tag. Server renders pass publishedCsp (lib/theme/csp.ts); the engine
   * itself has no Node imports so the editor can render in the browser.
   */
  csp?: (styleText: string) => string;
};

export type RenderResult = {
  html: string;
  /** The CSP written into the page, or "" when no csp builder was given. */
  csp: string;
  warnings: string[];
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

/** {% island %}…{% endisland %} marks where block JS mounts (#60). Until then it renders its body. */
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
    yield this.liquid.renderer.renderTemplates(this.body, ctx, emitter);
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

function engineFor(theme: ThemePackage): Liquid {
  let liquid = engines.get(theme);
  if (liquid) return liquid;
  const templates: Record<string, string> = {};
  for (const [name, source] of Object.entries(theme.templates)) templates[`${name}.liquid`] = source;
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
  engines.set(theme, liquid);
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
function renderProse(node: Prose, mode: RenderMode, lcp: boolean): string {
  const id = idAttribute(mode, node.id);
  if (node.tag === "img") {
    const driveFileId = node.image?.driveFileId ?? "";
    if (!driveFileId) return "";
    const alt = escapeHtml(node.image?.alt ?? "");
    const loading = lcp ? ` fetchpriority="high"` : ` loading="lazy" decoding="async"`;
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

export function renderPage(page: Page, theme: ThemePackage, options: RenderOptions = {}): RenderResult {
  const mode = options.mode ?? "publish";
  const template = options.template ?? "page";
  const { manifest } = theme;
  if (!Object.hasOwn(manifest.templates, template)) {
    throw new Error(`${manifest.name} has no "${template}" template`);
  }
  const liquid = engineFor(theme);
  const warnings: string[] = [];
  const html = new WeakMap<object, string>();
  const blocks: { view: BlockView }[] = [];
  const usedBlocks = new Set<string>();
  let lcpTaken = false;

  const prose = (node: Prose, sectionIndex: number): ProseView => {
    const view = proseView(node);
    const lcp = node.tag === "img" && !!node.image?.driveFileId && sectionIndex === 0 && !lcpTaken;
    if (lcp) lcpTaken = true;
    html.set(view, renderProse(node, mode, lcp));
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
  const scope = {
    page: pageView,
    site: { name: options.site?.name ?? "", url: options.site?.url ?? "", lang: options.site?.lang || "en" },
    theme: {
      name: manifest.name,
      version: manifest.version,
      tokens: { ...theme.tokens, ...(options.tokens ?? {}) },
      settings: { ...settingDefaults(theme), ...(options.settings ?? {}) },
    },
    mode,
  };

  const css = [theme.baseCss, ...Object.keys(manifest.blocks).filter((name) => usedBlocks.has(name)).map((name) => theme.blockCss[name] ?? "")]
    .filter(Boolean)
    .join("\n");
  const styleText = `\n${css}\n`;
  const csp = options.csp ? options.csp(styleText) : "";
  const cspMeta = csp ? `\n<meta http-equiv="Content-Security-Policy" content="${csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">` : "";
  const description = pageView.description
    ? `\n<meta name="description" content="${escapeHtml(pageView.description)}">`
    : "";
  const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${cspMeta}
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title>${description}
<style>${styleText}</style>`;

  const renderState: RenderState = { mode, html, head };
  const globals = { [STATE]: renderState };

  for (const { view } of blocks) {
    if (!view.declared) {
      html.set(view, fallbackBlock(view, mode, html));
      continue;
    }
    const out = liquid.renderFileSync(`blocks/${view.name}/block`, { ...scope, block: view }, { globals });
    html.set(view, String(out));
  }
  // Blocks were rendered in document order; a block never contains another block.
  const out = String(liquid.renderFileSync(`layouts/${template}`, scope, { globals }));
  if (out.length > LIMITS.outputBytes) throw new Error(`${manifest.name}: page output exceeds ${LIMITS.outputBytes} bytes`);
  return { html: out, csp, warnings };
}
