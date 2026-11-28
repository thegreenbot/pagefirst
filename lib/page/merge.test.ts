import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aboutFixture } from "./fixture";
import { diffPages } from "./diff";
import { mergePages, CONFLICT_POLICIES } from "./merge";
import type { Block, Page, Prose } from "./types";

const clone = (page: Page): Page => structuredClone(page);
const intro = (page: Page): Prose => page.sections[0]!.children[1] as Prose;
const heading = (page: Page): Prose => page.sections[0]!.children[0] as Prose;
const columns = (page: Page): Block => page.sections[2]!.children[0] as Block;
const texts = (page: Page) => page.sections.flatMap((s) => s.children).filter((n): n is Prose => n.kind === "prose").map((n) => n.text);

function scenario(editDoc: (p: Page) => void, editDraft: (p: Page) => void) {
  const base = aboutFixture();
  const doc = clone(base);
  doc.revisionId = "r2";
  editDoc(doc);
  const draft = clone(base);
  editDraft(draft);
  return { base, doc, draft };
}

describe("mergePages", () => {
  test("with no draft the result is the Doc and nothing conflicts", () => {
    const { base, doc } = scenario((p) => (intro(p).text = "Doc edit."), () => undefined);
    const result = mergePages(base, doc, null);
    assert.deepEqual(result.page, doc);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.incoming.map((c) => c.kind), ["prose.text"]);
  });

  test("a Doc change the draft left alone comes in; the draft's own change stays", () => {
    const { base, doc, draft } = scenario((p) => (intro(p).text = "Doc edit."), (p) => (heading(p).text = "Draft heading"));
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.equal(heading(result.page).text, "Draft heading");
    assert.equal(intro(result.page).text, "Doc edit.");
    assert.equal(result.page.revisionId, "r2");
    assert.deepEqual(result.incoming.map((c) => c.kind), ["prose.text"]);
  });

  test("both sides making the same change is not a conflict", () => {
    const { base, doc, draft } = scenario((p) => (intro(p).text = "Same."), (p) => (intro(p).text = "Same."));
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.equal(intro(result.page).text, "Same.");
  });

  test("tag on one side and text on the other merge", () => {
    const { base, doc, draft } = scenario((p) => (intro(p).tag = "h2"), (p) => (intro(p).text = "Draft text."));
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.equal(intro(result.page).tag, "h2");
    assert.equal(intro(result.page).text, "Draft text.");
  });

  describe("the same text changed on both sides", () => {
    const make = () => scenario((p) => (intro(p).text = "From the Doc."), (p) => (intro(p).text = "From the draft."));
    const expected: Record<string, [string, boolean]> = {
      manual: ["From the draft.", true],
      "doc-wins": ["From the Doc.", false],
      "draft-wins": ["From the draft.", false],
    };
    for (const [policy, [text, review]] of Object.entries(expected)) {
      test(policy, () => {
        const { base, doc, draft } = make();
        const result = mergePages(base, doc, draft, policy as "manual");
        assert.equal(result.ok, true);
        assert.equal(intro(result.page).text, text);
        assert.equal(result.needsReview, review);
        assert.equal(result.conflicts.length, 1);
        assert.equal(result.conflicts[0]!.unit, `node:${intro(base).id}:text`);
      });
    }
    test("fail returns the Doc untouched and the conflicts", () => {
      const { base, doc, draft } = make();
      const result = mergePages(base, doc, draft, "fail");
      assert.equal(result.ok, false);
      assert.deepEqual(result.page, doc);
      assert.equal(result.conflicts.length, 1);
    });
  });

  test("every policy name is known", () => {
    assert.deepEqual([...CONFLICT_POLICIES].sort(), ["doc-wins", "draft-wins", "fail", "manual"]);
  });

  test("additions on both sides all survive, each next to its own neighbour", () => {
    const { base, doc, draft } = scenario(
      (p) => p.sections[0]!.children.push({ kind: "prose", id: "n_doc", tag: "p", text: "Added in Doc." }),
      (p) => p.sections[0]!.children.splice(1, 0, { kind: "prose", id: "n_draft", tag: "p", text: "Added in draft." }),
    );
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(texts(result.page).slice(0, 4), ["About the studio", "Added in draft.", "A one-paragraph introduction.", "Added in Doc."]);
  });

  test("a node the Doc deleted and the draft left alone is removed", () => {
    const { base, doc, draft } = scenario((p) => p.sections[0]!.children.splice(1, 1), (p) => (heading(p).text = "Draft heading"));
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.equal(result.page.sections[0]!.children.length, 1);
  });

  test("deleted in the Doc but edited in the draft is a conflict settled by policy", () => {
    const make = () => scenario((p) => p.sections[0]!.children.splice(1, 1), (p) => (intro(p).text = "Draft edit."));
    const manual = make();
    const kept = mergePages(manual.base, manual.doc, manual.draft, "manual");
    assert.equal(kept.conflicts.length, 1);
    assert.equal(kept.page.sections[0]!.children.length, 2);
    const doc = make();
    assert.equal(mergePages(doc.base, doc.doc, doc.draft, "doc-wins").page.sections[0]!.children.length, 1);
  });

  test("edited in the Doc but deleted in the draft is a conflict too", () => {
    const make = () => scenario((p) => (intro(p).text = "Doc edit."), (p) => p.sections[0]!.children.splice(1, 1));
    const a = make();
    assert.equal(mergePages(a.base, a.doc, a.draft, "draft-wins").page.sections[0]!.children.length, 1);
    const b = make();
    assert.equal(mergePages(b.base, b.doc, b.draft, "doc-wins").page.sections[0]!.children.length, 2);
  });

  test("metadata merges per key", () => {
    const { base, doc, draft } = scenario(
      (p) => { p.metadata.title = "Doc title"; p.metadata.extra = "x"; },
      (p) => { p.metadata.description = "Draft description"; delete p.metadata.nothing; },
    );
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.page.metadata, { title: "Doc title", description: "Draft description", extra: "x" });
    const clash = scenario((p) => (p.metadata.title = "A"), (p) => (p.metadata.title = "B"));
    const resolved = mergePages(clash.base, clash.doc, clash.draft, "doc-wins");
    assert.equal(resolved.page.metadata.title, "A");
  });

  test("block cells merge independently and conflict per cell", () => {
    const { base, doc, draft } = scenario(
      (p) => (columns(p).rows[0]![0]!.children[1]!.text = "Doc left"),
      (p) => (columns(p).rows[0]![1]!.children[1]!.text = "Draft right"),
    );
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    const cells = columns(result.page).rows[0]!;
    assert.equal(cells[0]!.children[1]!.text, "Doc left");
    assert.equal(cells[1]!.children[1]!.text, "Draft right");
    const clash = scenario((p) => (columns(p).rows[0]![0]!.children[1]!.text = "A"), (p) => (columns(p).rows[0]![0]!.children[1]!.text = "B"));
    const resolved = mergePages(clash.base, clash.doc, clash.draft, "manual");
    assert.match(resolved.conflicts[0]!.unit, /cell:0:0$/);
  });

  test("a move in the Doc and a text edit in the draft both apply", () => {
    const { base, doc, draft } = scenario(
      (p) => { const [node] = p.sections[0]!.children.splice(1, 1); p.sections[2]!.children.push(node!); },
      (p) => (intro(p).text = "Draft intro."),
    );
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.conflicts, []);
    const moved = result.page.sections[2]!.children.find((n) => n.id === intro(base).id) as Prose;
    assert.equal(moved.text, "Draft intro.");
  });

  test("the merged page diffed against the draft is exactly what comes in", () => {
    const { base, doc, draft } = scenario((p) => (intro(p).text = "Doc edit."), (p) => (heading(p).text = "Draft heading"));
    const result = mergePages(base, doc, draft);
    assert.deepEqual(result.incoming, diffPages(draft, result.page));
  });

  test("merging is deterministic and does not modify its inputs", () => {
    const { base, doc, draft } = scenario((p) => (intro(p).text = "Doc."), (p) => (intro(p).text = "Draft."));
    const snapshot = JSON.stringify([base, doc, draft]);
    const first = mergePages(base, doc, draft);
    const second = mergePages(base, doc, draft);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify([base, doc, draft]), snapshot);
  });

  test("a draft identical to the base takes the Doc as is", () => {
    const { base, doc } = scenario((p) => { intro(p).text = "Doc."; p.sections[1]!.style = ["dark"]; p.metadata.title = "T"; }, () => undefined);
    const result = mergePages(base, doc, clone(base));
    assert.deepEqual(result.page, doc);
    assert.deepEqual(result.conflicts, []);
  });
});
