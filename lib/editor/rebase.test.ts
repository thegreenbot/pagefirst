import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { aboutFixture } from "@/lib/page/fixture";
import { applyOps } from "@/lib/page/ops";
import type { Prose } from "@/lib/page/types";
import { rebaseOps } from "./rebase";

const proses = (page: ReturnType<typeof aboutFixture>) =>
  page.sections.flatMap((s) => s.children).filter((n): n is Prose => n.kind === "prose");

describe("rebaseOps", () => {
  test("keeps unrelated draft ops on top of the imported Doc", () => {
    const base = aboutFixture();
    const [a, b] = proses(base);
    const doc = applyOps(base, [{ op: "replaceText", nodeId: a!.id, text: "Doc edit." }]);
    const result = rebaseOps(doc, [{ op: "replaceText", nodeId: b!.id, text: "My edit." }], new Set());
    assert.equal(result.dropped.length, 0);
    const [ra, rb] = proses(result.page);
    assert.equal(ra!.text, "Doc edit.");
    assert.equal(rb!.text, "My edit.");
    assert.equal(result.page.revisionId, doc.revisionId);
  });

  test("drops ops on a unit the author gave to the Doc", () => {
    const base = aboutFixture();
    const [a] = proses(base);
    const doc = applyOps(base, [{ op: "replaceText", nodeId: a!.id, text: "Doc edit." }]);
    const result = rebaseOps(doc, [{ op: "replaceText", nodeId: a!.id, text: "Mine." }], new Set([`node:${a!.id}:text`]));
    assert.equal(result.kept.length, 0);
    assert.equal(proses(result.page)[0]!.text, "Doc edit.");
  });

  test("drops ops on a node the Doc removed, and keeps the rest", () => {
    const base = aboutFixture();
    const [a, b] = proses(base);
    const doc = applyOps(base, [{ op: "removeNode", nodeId: a!.id }]);
    const result = rebaseOps(doc, [{ op: "replaceText", nodeId: a!.id, text: "x" }, { op: "replaceText", nodeId: b!.id, text: "kept" }], new Set());
    assert.equal(result.dropped.length, 1);
    assert.equal(result.kept.length, 1);
  });

  test("a metadata choice drops only that key", () => {
    const base = aboutFixture();
    const result = rebaseOps(base, [{ op: "setMetadata", key: "title", value: "T" }, { op: "setMetadata", key: "description", value: "D" }], new Set(["meta:title"]));
    assert.equal(result.kept.length, 1);
    assert.equal(result.page.metadata.description, "D");
  });
});
