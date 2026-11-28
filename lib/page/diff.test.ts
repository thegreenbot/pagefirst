import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aboutFixture, blankPage } from "./fixture";
import { diffPages, textDiff, untrackedNodeIds, type PageChange } from "./diff";
import { applyOps } from "./ops";
import type { Block, Page, Prose } from "./types";

const clone = (page: Page): Page => structuredClone(page);
const kinds = (changes: PageChange[]) => changes.map((change) => change.kind);
const firstProse = (page: Page): Prose => page.sections[0]!.children.find((node): node is Prose => node.kind === "prose" && node.tag === "p")!;
const heroOf = (page: Page): Block => page.sections[1]!.children[0] as Block;
const columnsOf = (page: Page): Block => page.sections[2]!.children[0] as Block;

describe("diffPages", () => {
  test("a page diffed with itself is empty, for every fixture", () => {
    for (const page of [aboutFixture(), blankPage("Hello world")]) {
      assert.deepEqual(diffPages(page, page), []);
      assert.deepEqual(diffPages(page, clone(page)), []);
    }
  });

  test("the revision id alone is not a change", () => {
    const page = aboutFixture();
    assert.deepEqual(diffPages(page, { ...clone(page), revisionId: "r9" }), []);
  });

  type Case = { name: string; edit: (page: Page) => void; expect: string[]; check?: (changes: PageChange[], before: Page, after: Page) => void };
  const cases: Case[] = [
    { name: "text edit", edit: (p) => (firstProse(p).text = "A rewritten introduction."), expect: ["prose.text"], check: (c) => {
      const change = c[0] as Extract<PageChange, { kind: "prose.text" }>;
      assert.equal(change.after, "A rewritten introduction.");
      assert.ok(change.diff.some((segment) => segment.op === "insert"));
    } },
    { name: "tag change", edit: (p) => (firstProse(p).tag = "h2"), expect: ["prose.tag"] },
    { name: "tag and text together", edit: (p) => { const n = firstProse(p); n.tag = "h3"; n.text = "new"; }, expect: ["prose.tag", "prose.text"] },
    { name: "list items", edit: (p) => { const n = firstProse(p); n.tag = "ul"; delete n.text; n.items = ["a", "b"]; }, expect: ["prose.tag", "prose.text"] },
    { name: "block options", edit: (p) => (columnsOf(p).options = ["contained", "dark"]), expect: ["block.options"] },
    { name: "block renamed", edit: (p) => (columnsOf(p).name = "cards"), expect: ["block.name"] },
    { name: "cell content, addressed by row and column", edit: (p) => (columnsOf(p).rows[0]![1]!.children[1]!.text = "Changed."), expect: ["cell.content"], check: (c) => {
      const change = c[0] as Extract<PageChange, { kind: "cell.content" }>;
      assert.deepEqual([change.row, change.col], [0, 1]);
    } },
    { name: "block row added", edit: (p) => columnsOf(p).rows.push([{ id: "c_new", children: [{ kind: "prose", id: "n_cell", tag: "p", text: "Extra" }] }]), expect: ["block.shape", "cell.content"] },
    { name: "image changed", edit: (p) => { const img = (heroOf(p).rows[1]![0]!.children[0]!); img.image = { driveFileId: "other", alt: "Studio" }; }, expect: ["cell.content"] },
    { name: "image alt on a top-level image", edit: (p) => { p.sections[0]!.children.push({ kind: "prose", id: "n_img", tag: "img", image: { driveFileId: "x", alt: "a" } }); }, expect: ["node.added"] },
    { name: "metadata added, changed, removed", edit: (p) => { p.metadata.extra = "1"; p.metadata.title = "Renamed"; delete p.metadata.description; }, expect: ["meta.added", "meta.changed", "meta.removed"] },
    { name: "node added", edit: (p) => p.sections[0]!.children.splice(1, 0, { kind: "prose", id: "n_added", tag: "p", text: "Inserted." }), expect: ["node.added"] },
    { name: "node removed", edit: (p) => p.sections[0]!.children.splice(1, 1), expect: ["node.removed"] },
    { name: "node moved within a section", edit: (p) => p.sections[0]!.children.reverse(), expect: ["node.moved"] },
    { name: "node moved between sections", edit: (p) => { const [node] = p.sections[0]!.children.splice(1, 1); p.sections[2]!.children.push(node!); }, expect: ["node.moved"], check: (c) => {
      const change = c[0] as Extract<PageChange, { kind: "node.moved" }>;
      assert.notEqual(change.from.sectionId, change.to.sectionId);
    } },
    { name: "section added", edit: (p) => p.sections.splice(1, 0, { id: "s_new", style: [], children: [] }), expect: ["section.added"] },
    { name: "section removed with its nodes", edit: (p) => p.sections.splice(2, 1), expect: ["section.removed", "node.removed"] },
    { name: "section moved", edit: (p) => p.sections.reverse(), expect: [] },
    { name: "section style", edit: (p) => (p.sections[1]!.style = ["highlight"]), expect: ["section.style"] },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const before = aboutFixture();
      const after = clone(before);
      c.edit(after);
      const changes = diffPages(before, after);
      if (c.name === "section moved") {
        assert.ok(kinds(changes).includes("section.moved"));
        assert.ok(!kinds(changes).includes("node.moved"));
        return;
      }
      assert.deepEqual(kinds(changes), c.expect);
      c.check?.(changes, before, after);
    });
  }

  test("inserting a node does not report its neighbours as moved", () => {
    const before = aboutFixture();
    const after = clone(before);
    after.sections[0]!.children.unshift({ kind: "prose", id: "n_first", tag: "p", text: "First." });
    assert.deepEqual(kinds(diffPages(before, after)), ["node.added"]);
  });

  test("nodes the Doc holds without a named range are untracked, not added", () => {
    const before = aboutFixture();
    const after = clone(before);
    after.sections[0]!.children.push({ kind: "prose", id: "n_fresh", tag: "p", text: "Typed in the Doc." });
    const changes = diffPages(before, after, { untracked: new Set(["n_fresh"]) });
    assert.deepEqual(kinds(changes), ["node.untracked"]);
    const doc = { namedRanges: { a: { name: `pg/node/${before.sections[0]!.children[0]!.id}` } } };
    assert.deepEqual([...untrackedNodeIds(doc, after)].sort(), [...after.sections.flatMap((s) => s.children.map((n) => n.id))].filter((id) => id !== before.sections[0]!.children[0]!.id).sort());
  });

  test("a change list is serialisable and deterministic", () => {
    const before = aboutFixture();
    const after = clone(before);
    firstProse(after).text = "Different.";
    after.metadata.title = "New";
    const once = diffPages(before, after);
    assert.deepEqual(JSON.parse(JSON.stringify(once)), once);
    assert.deepEqual(diffPages(before, after), once);
  });

  test("ops applied to a page diff to the matching change kinds", () => {
    const before = aboutFixture();
    const node = firstProse(before);
    const after = applyOps(before, [{ op: "replaceText", nodeId: node.id, text: "Edited." }, { op: "setMetadata", key: "title", value: "T" }]);
    assert.deepEqual(kinds(diffPages(before, after)), ["meta.changed", "prose.text"]);
  });
});

describe("textDiff", () => {
  const join = (segments: { op: string; text: string }[], ops: string[]) => segments.filter((s) => ops.includes(s.op)).map((s) => s.text).join("");

  test("reconstructs both sides", () => {
    for (const [a, b] of [["the quick brown fox", "the slow brown dog"], ["", "new"], ["old", ""], ["same", "same"], ["a  b", "a b"]] as const) {
      const diff = textDiff(a, b);
      assert.equal(join(diff, ["equal", "delete"]), a);
      assert.equal(join(diff, ["equal", "insert"]), b);
    }
  });

  test("marks only the changed words", () => {
    assert.deepEqual(textDiff("one two three", "one 2 three"), [
      { op: "equal", text: "one " },
      { op: "delete", text: "two" },
      { op: "insert", text: "2" },
      { op: "equal", text: " three" },
    ]);
  });

  test("very large rewrites fall back to one delete and one insert", () => {
    const a = Array.from({ length: 2500 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 2500 }, (_, i) => `b${i}`).join(" ");
    assert.equal(textDiff(a, b).length, 2);
  });
});
