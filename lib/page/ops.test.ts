import assert from "node:assert/strict";
import { test } from "node:test";
import { aboutFixture, blankPage } from "./fixture";
import { applyOps } from "./ops";
import type { Block, Op, Page, Prose } from "./types";

function proseAt(page: Page, sectionIndex: number, childIndex: number): Prose {
  const node = page.sections[sectionIndex].children[childIndex];
  assert.equal(node.kind, "prose");
  if (node.kind !== "prose") throw new Error("expected prose");
  return node;
}

function blockAt(page: Page, sectionIndex: number, childIndex: number): Block {
  const node = page.sections[sectionIndex].children[childIndex];
  assert.equal(node.kind, "block");
  if (node.kind !== "block") throw new Error("expected block");
  return node;
}

test("replaceText updates the heading and bumps the revision", () => {
  const page = aboutFixture();
  const heading = proseAt(page, 0, 0);
  assert.equal(heading.text, "About the studio");
  const next = applyOps(page, [{ op: "replaceText", nodeId: heading.id, text: "Updated title" }]);
  assert.equal(next.revisionId, "r2");
  assert.equal(page.revisionId, "r1");
  assert.equal(proseAt(next, 0, 0).text, "Updated title");
  assert.equal(heading.text, "About the studio");
  assert.equal(proseAt(next, 0, 0).id, heading.id);

  const image = blockAt(page, 1, 0).rows[1][0].children[0];
  const captioned = applyOps(page, [{ op: "replaceText", nodeId: image.id, text: "caption" }]);
  const updated = blockAt(captioned, 1, 0).rows[1][0].children[0];
  assert.equal(updated.tag, "img");
  assert.equal(updated.text, "caption");
  assert.deepEqual(updated.image, { driveFileId: "sample-studio", alt: "Studio" });
  assert.equal(image.text, undefined);
});

test("removeNode drops the hero block", () => {
  const page = aboutFixture();
  const hero = blockAt(page, 1, 0);
  assert.equal(hero.name, "hero");
  const next = applyOps(page, [{ op: "removeNode", nodeId: hero.id }]);
  assert.equal(next.sections[1].children.length, 0);
  assert.equal(page.sections[1].children.length, 1);
  assert.equal(blockAt(page, 1, 0).name, "hero");
  assert.equal(next.revisionId, "r2");
});

test("moveNode moves a direct child between sections", () => {
  const page = aboutFixture();
  const intro = proseAt(page, 0, 1);
  const destination = page.sections[2].id;
  const moved = applyOps(page, [
    { op: "moveNode", nodeId: intro.id, toSectionId: destination, index: 0 },
  ]);
  assert.equal(moved.sections[0].children.length, 1);
  assert.equal(proseAt(moved, 0, 0).tag, "h1");
  assert.equal(moved.sections[2].children[0].id, intro.id);
  assert.equal(moved.sections[2].children.length, 2);
  assert.equal(blockAt(moved, 2, 1).name, "columns");
  assert.equal(page.sections[0].children.length, 2);
  assert.equal(page.sections[2].children.length, 1);

  const same = applyOps(page, [
    { op: "moveNode", nodeId: proseAt(page, 0, 0).id, toSectionId: page.sections[0].id, index: 2 },
  ]);
  assert.equal(proseAt(same, 0, 0).text, "A one-paragraph introduction.");
  assert.equal(proseAt(same, 0, 1).text, "About the studio");
});

test("unknown ids and unknown ops throw", () => {
  const page = aboutFixture();
  assert.throws(
    () => applyOps(page, [{ op: "replaceText", nodeId: "missing-node", text: "x" }]),
    { message: "Unknown node missing-node" },
  );
  assert.throws(() => applyOps(page, [{ op: "removeNode", nodeId: "missing-node" }]), {
    message: "Unknown node missing-node",
  });
  assert.throws(
    () =>
      applyOps(page, [
        { op: "moveNode", nodeId: "missing-node", toSectionId: page.sections[0].id, index: 0 },
      ]),
    { message: "Unknown node missing-node" },
  );
  assert.throws(
    () =>
      applyOps(page, [
        { op: "moveNode", nodeId: proseAt(page, 0, 0).id, toSectionId: "missing-section", index: 0 },
      ]),
    { message: "Unknown node missing-section" },
  );
  assert.throws(
    () =>
      applyOps(page, [
        {
          op: "insertBlock",
          sectionId: "missing-section",
          index: 0,
          block: { kind: "block", id: "b", name: "cards", options: [], rows: [] },
        },
      ]),
    { message: "Unknown node missing-section" },
  );
  assert.throws(
    () => applyOps(page, [{ op: "moveNode", nodeId: page.sections[0].id, toSectionId: page.sections[1].id, index: 0 }]),
    { message: `Unknown node ${page.sections[0].id}` },
  );
  assert.throws(() => applyOps(page, [{ op: "nope" } as unknown as Op]), {
    message: "Unknown op nope",
  });
  assert.equal(page.revisionId, "r1");
  assert.equal(proseAt(page, 0, 0).text, "About the studio");
});

test("edits tags, images, metadata, options, and lists", () => {
  const page = aboutFixture();
  const heading = proseAt(page, 0, 0);
  const intro = proseAt(page, 0, 1);
  const hero = blockAt(page, 1, 0);
  const next = applyOps(page, [
    { op: "setTag", nodeId: heading.id, tag: "h2" },
    { op: "setImage", nodeId: intro.id, driveFileId: "pic", alt: "Alt" },
    { op: "setMetadata", key: "description", value: "" },
    { op: "setMetadata", key: "theme", value: "paper" },
    { op: "setBlockOptions", nodeId: hero.id, options: ["wide", "dark"] },
  ]);
  assert.equal(next.revisionId, "r2");
  assert.equal(proseAt(next, 0, 0).tag, "h2");
  assert.equal(proseAt(next, 0, 0).text, "About the studio");
  assert.equal(proseAt(next, 0, 1).tag, "img");
  assert.deepEqual(proseAt(next, 0, 1).image, { driveFileId: "pic", alt: "Alt" });
  assert.equal(next.metadata.description, undefined);
  assert.equal(next.metadata.theme, "paper");
  assert.equal(next.metadata.title, "About");
  assert.deepEqual(blockAt(next, 1, 0).options, ["wide", "dark"]);
  assert.equal(page.metadata.description, "What the studio ships.");
  assert.deepEqual(hero.options, []);

  const listPage: Page = {
    fileId: "f",
    revisionId: "r3",
    path: "list",
    metadata: {},
    sections: [
      {
        id: "s",
        style: [],
        children: [{ kind: "prose", id: "list", tag: "ul", items: ["a", "b"] }],
      },
    ],
  };
  const listed = applyOps(listPage, [{ op: "replaceText", nodeId: "list", text: "a\n\nb" }]);
  assert.deepEqual(proseAt(listed, 0, 0).items, ["a", "", "b"]);
  assert.equal(listed.revisionId, "r4");
  const cleared = applyOps(listPage, [{ op: "replaceText", nodeId: "list", text: "" }]);
  assert.deepEqual(proseAt(cleared, 0, 0).items, []);
  const paragraph = applyOps(listPage, [{ op: "setTag", nodeId: "list", tag: "p" }]);
  assert.equal(proseAt(paragraph, 0, 0).tag, "p");
  assert.equal(proseAt(paragraph, 0, 0).text, "a\nb");
  const kept: Page = {
    ...listPage,
    sections: [
      {
        id: "s",
        style: [],
        children: [{ kind: "prose", id: "list", tag: "ul", text: "keep", items: ["a", "b"] }],
      },
    ],
  };
  const still = applyOps(kept, [{ op: "setTag", nodeId: "list", tag: "h3" }]);
  assert.equal(proseAt(still, 0, 0).text, "keep");
  assert.equal(proseAt(still, 0, 0).tag, "h3");
});

test("inserts, clamps, and removes nested prose or the only section", () => {
  const page = aboutFixture();
  const node: Prose = { kind: "prose", id: "inserted", tag: "p", text: "New" };
  const block: Block = { kind: "block", id: "cards-1", name: "cards", options: ["dark"], rows: [] };
  const inserted = applyOps(page, [
    { op: "insertProse", sectionId: page.sections[0].id, index: 99, node },
    { op: "insertBlock", sectionId: page.sections[1].id, index: -3, block },
    { op: "insertSection", index: 1 },
  ]);
  node.text = "Changed";
  block.name = "changed";
  assert.equal(inserted.sections.length, 4);
  assert.equal(inserted.sections[1].children.length, 0);
  assert.deepEqual(inserted.sections[1].style, []);
  assert.equal(proseAt(inserted, 0, 2).text, "New");
  assert.equal(blockAt(inserted, 2, 0).name, "cards");
  assert.equal(blockAt(inserted, 2, 1).name, "hero");
  assert.equal(page.sections.length, 3);

  const columns = blockAt(page, 2, 0);
  const left = columns.rows[0][0].children[0];
  const removed = applyOps(page, [{ op: "removeNode", nodeId: left.id }]);
  assert.deepEqual(
    blockAt(removed, 2, 0).rows[0][0].children.map((item) => item.text),
    ["First point."],
  );
  assert.equal(columns.rows[0][0].children.length, 2);

  const sectionId = page.sections[1].id;
  const dropped = applyOps(page, [{ op: "removeNode", nodeId: sectionId }]);
  assert.equal(dropped.sections.length, 2);
  assert.equal(dropped.sections[0].id, page.sections[0].id);
  assert.equal(dropped.sections[1].id, page.sections[2].id);

  const only = blankPage("Notes");
  const cleared = applyOps(only, [{ op: "removeNode", nodeId: only.sections[0].id }]);
  assert.equal(cleared.sections.length, 1);
  assert.equal(cleared.sections[0].id, only.sections[0].id);
  assert.deepEqual(cleared.sections[0].children, []);
  assert.equal(only.sections[0].children.length, 2);
});
