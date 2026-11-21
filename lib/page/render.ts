import type { Block, Page, Prose, Section } from "./types";

const STYLE = `body{background:#f4f0e6;color:#1c1915}
main{max-width:40rem;margin:0 auto}
h1,h2,h3,h4{font-family:Georgia,"Times New Roman",serif}
.section{margin:2rem 0}
.hero,.columns,.cards{display:flex;flex-direction:column}
img{max-width:100%}`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function classAttribute(tokens: string[]): string {
  const value = tokens.map((token) => token.trim()).filter(Boolean).join(" ");
  return ` class="${escapeHtml(value)}"`;
}

function publishTitle(page: Page): string {
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

function renderProse(node: Prose): string {
  if (node.tag === "img") {
    const driveFileId = node.image?.driveFileId ?? "";
    if (!driveFileId) return "";
    const alt = node.image?.alt ?? "";
    return `<img src="/api/media/${escapeHtml(driveFileId)}" alt="${escapeHtml(alt)}">`;
  }
  if (node.tag === "ul" || node.tag === "ol") {
    const items = (node.items ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    return `<${node.tag}>${items}</${node.tag}>`;
  }
  const tag = node.tag === "h1" || node.tag === "h2" || node.tag === "h3" || node.tag === "h4" || node.tag === "p"
    ? node.tag
    : "p";
  return `<${tag}>${escapeHtml(node.text ?? "")}</${tag}>`;
}

function renderBlock(block: Block): string {
  const cells = block.rows
    .flatMap((row) => row)
    .map((cell) => `<div>${cell.children.map(renderProse).join("")}</div>`)
    .join("");
  return `<div${classAttribute([block.name, ...block.options])}>${cells}</div>`;
}

function renderSection(section: Section): string {
  const inner = section.children
    .map((child) => (child.kind === "prose" ? renderProse(child) : renderBlock(child)))
    .join("");
  return `<div${classAttribute(["section", ...section.style])}>${inner}</div>`;
}

export function renderPublishHtml(page: Page): string {
  const description = page.metadata.description
    ? `<meta name="description" content="${escapeHtml(page.metadata.description)}">\n`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(publishTitle(page))}</title>
${description}<style>
${STYLE}
</style>
</head>
<body>
<main>
${page.sections.map(renderSection).join("\n")}
</main>
</body>
</html>
`;
}
