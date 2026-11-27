import { createId } from "./types";
import type { Page, Prose, Block } from "./types";

function prose(
  tag: Prose["tag"],
  text?: string,
  image?: Prose["image"],
): Prose {
  const node: Prose = { kind: "prose", id: createId("n"), tag };
  if (text !== undefined) node.text = text;
  if (image) node.image = image;
  return node;
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function aboutFixture(): Page {
  const hero: Block = {
    kind: "block",
    id: createId("n"),
    name: "hero",
    options: [],
    rows: [
      [{ id: createId("c"), children: [prose("p", "The work, plainly described.")] }],
      [
        {
          id: createId("c"),
          children: [prose("img", undefined, { driveFileId: "sample-studio", alt: "Studio" })],
        },
      ],
    ],
  };
  const columns: Block = {
    kind: "block",
    id: createId("n"),
    name: "columns",
    options: ["contained"],
    rows: [
      [
        {
          id: createId("c"),
          children: [prose("p", "Left column"), prose("p", "First point.")],
        },
        {
          id: createId("c"),
          children: [prose("p", "Right column"), prose("p", "Second point.")],
        },
      ],
    ],
  };
  return {
    fileId: "about",
    revisionId: "r1",
    path: "about",
    metadata: {
      title: "About",
      description: "What the studio ships.",
    },
    sections: [
      {
        id: createId("s"),
        style: [],
        children: [prose("h1", "About the studio"), prose("p", "A one-paragraph introduction.")],
      },
      { id: createId("s"), style: [], children: [hero] },
      { id: createId("s"), style: [], children: [columns] },
    ],
  };
}

export function blankPage(title: string): Page {
  return {
    fileId: createId("page"),
    revisionId: "r1",
    path: slug(title) || "page",
    metadata: { title },
    sections: [
      {
        id: createId("s"),
        style: [],
        children: [prose("h1", title), prose("p", "")],
      },
    ],
  };
}
