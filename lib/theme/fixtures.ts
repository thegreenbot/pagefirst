import { aboutFixture } from "@/lib/page/fixture";
import type { Block, Page, Prose, Section } from "@/lib/page/types";
import type { ThemeManifest } from "./manifest";

/**
 * Fixture pages every theme is measured against (#58). They are built from the
 * manifest, so third-party themes get the same set: the PLAN.md fixture Doc, a
 * long article, a page with every declared block, and a large-image worst case.
 */

export type Fixture = { name: string; page: Page };

let counter = 0;
const id = (prefix: string) => `${prefix}${++counter}`;

const SENTENCE =
  "Pagefirst turns a Google Doc into a fast page, and this sentence stands in for the kind of paragraph a real author writes about their work.";

function prose(tag: Prose["tag"], text?: string): Prose {
  return { kind: "prose", id: id("n"), tag, text };
}

function image(name: string, alt: string): Prose {
  return { kind: "prose", id: id("n"), tag: "img", image: { driveFileId: name, alt } };
}

function list(tag: "ul" | "ol", items: string[]): Prose {
  return { kind: "prose", id: id("n"), tag, items };
}

function section(children: Section["children"], style: string[] = []): Section {
  return { id: id("s"), style, children };
}

function page(fileId: string, title: string, sections: Section[]): Page {
  return { fileId, revisionId: "r1", path: fileId, metadata: { title, description: `${title} fixture page.` }, sections };
}

function article(): Page {
  const sections: Section[] = [section([prose("h1", "A long article"), prose("p", SENTENCE.repeat(2))])];
  for (let part = 1; part <= 8; part++) {
    sections.push(
      section([
        prose("h2", `Part ${part}`),
        ...Array.from({ length: 5 }, () => prose("p", SENTENCE.repeat(3))),
        list(part % 2 ? "ul" : "ol", ["First point to remember", "Second point to remember", "Third point to remember"]),
        ...(part % 3 === 0 ? [image(`article-${part}`, `Illustration for part ${part}`)] : []),
      ]),
    );
  }
  return page("fixture-article", "Long article", sections);
}

function blockFor(name: string, manifest: ThemeManifest, options: string[]): Block {
  const shape = manifest.blocks[name].shape ?? {};
  const rows = Math.max(shape.minRows ?? 1, Math.min(shape.maxRows ?? 3, 3));
  const columns = Math.max(1, Math.min(shape.columns ?? 2, 4));
  return {
    kind: "block",
    id: id("n"),
    name,
    options,
    rows: Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) => ({
        id: id("c"),
        children:
          row === 0 && column === 0
            ? [image(`${name}-${row}-${column}`, `${manifest.blocks[name].label} image`)]
            : [prose("h3", `${manifest.blocks[name].label} ${row + 1}.${column + 1}`), prose("p", SENTENCE)],
      })),
    ),
  };
}

function everyBlock(manifest: ThemeManifest): Page {
  const styles = manifest.sectionStyles ?? [];
  const sections = [section([prose("h1", "Every block"), prose("p", SENTENCE)])];
  Object.keys(manifest.blocks).forEach((name, index) => {
    const style = styles.length ? [styles[index % styles.length]] : [];
    sections.push(section([prose("h2", manifest.blocks[name].label), blockFor(name, manifest, [...(manifest.blocks[name].options ?? [])])], style));
  });
  return page("fixture-every-block", "Every block", sections);
}

function largeImages(): Page {
  const sections = [section([prose("h1", "Large images"), image("large-hero", "A large hero image"), prose("p", SENTENCE)])];
  for (let part = 1; part <= 4; part++) {
    sections.push(section([prose("h2", `Gallery ${part}`), ...Array.from({ length: 4 }, (_, n) => image(`large-${part}-${n}`, `Photo ${part}.${n + 1}`))]));
  }
  return page("fixture-large-images", "Large images", sections);
}

export function themeFixtures(manifest: ThemeManifest): Fixture[] {
  counter = 0;
  return [
    { name: "about", page: aboutFixture() },
    { name: "article", page: article() },
    { name: "every-block", page: everyBlock(manifest) },
    { name: "large-images", page: largeImages() },
  ];
}
