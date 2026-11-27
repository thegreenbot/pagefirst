import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { LIMITS, validateCommitRequest } from "./validate";

const prose = { kind: "prose", id: "n_1", tag: "p", text: "Hi" };
const block = {
  kind: "block",
  id: "b_1",
  name: "columns",
  options: ["contained"],
  rows: [[{ id: "c_1", children: [prose] }]],
};

const valid: Record<string, object> = {
  replaceText: { op: "replaceText", nodeId: "n_1", text: "Hello" },
  setTag: { op: "setTag", nodeId: "n_1", tag: "h2" },
  setBlockOptions: { op: "setBlockOptions", nodeId: "b_1", options: ["contained", "Dark mode"] },
  setMetadata: { op: "setMetadata", key: "description", value: "" },
  insertBlock: { op: "insertBlock", sectionId: "s_1", index: 0, block },
  insertProse: { op: "insertProse", sectionId: "s_1", index: 2, node: { ...prose, tag: "ul", items: ["a", "b"] } },
  insertSection: { op: "insertSection", index: 1 },
  removeNode: { op: "removeNode", nodeId: "n_1" },
  moveNode: { op: "moveNode", nodeId: "n_1", toSectionId: "s_2", index: 0 },
  setImage: { op: "setImage", nodeId: "n_1", driveFileId: "m_abc", alt: "A cat" },
};

const invalid: Record<string, [object, string][]> = {
  replaceText: [
    [{ op: "replaceText", nodeId: "bad id", text: "x" }, "ops[0].nodeId"],
    [{ op: "replaceText", nodeId: "n_1", text: 5 }, "ops[0].text"],
    [{ op: "replaceText", nodeId: "n_1", text: "x".repeat(LIMITS.maxTextLength + 1) }, "ops[0].text"],
  ],
  setTag: [[{ op: "setTag", nodeId: "n_1", tag: "script" }, "ops[0].tag"]],
  setBlockOptions: [
    [{ op: "setBlockOptions", nodeId: "b_1", options: "contained" }, "ops[0].options"],
    [{ op: "setBlockOptions", nodeId: "b_1", options: ["a)b"] }, "ops[0].options[0]"],
    [{ op: "setBlockOptions", nodeId: "b_1", options: Array(LIMITS.maxOptions + 1).fill("x") }, "ops[0].options"],
  ],
  setMetadata: [
    [{ op: "setMetadata", key: "__proto__", value: "x" }, "ops[0].key"],
    [{ op: "setMetadata", key: "title", value: "x".repeat(LIMITS.maxMetadataValueLength + 1) }, "ops[0].value"],
  ],
  insertBlock: [
    [{ op: "insertBlock", sectionId: "s_1", index: 0, block: { ...block, name: "iframe" } }, "ops[0].block.name"],
    [{ op: "insertBlock", sectionId: "s_1", index: -1, block }, "ops[0].index"],
    [{ op: "insertBlock", sectionId: "s_1", index: 0, block: { ...block, kind: "prose" } }, "ops[0].block.kind"],
    [
      { op: "insertBlock", sectionId: "s_1", index: 0, block: { ...block, rows: [[{ id: "c_1", children: [{ ...prose, tag: "div" }] }]] } },
      "ops[0].block.rows[0][0].children[0].tag",
    ],
  ],
  insertProse: [
    [{ op: "insertProse", sectionId: "s_1", index: 1.5, node: prose }, "ops[0].index"],
    [{ op: "insertProse", sectionId: "s_1", index: 0, node: { ...prose, onclick: "x" } }, "ops[0].node.onclick"],
    [{ op: "insertProse", sectionId: "s_1", index: 0, node: { ...prose, image: { driveFileId: "../x", alt: "" } } }, "ops[0].node.image.driveFileId"],
  ],
  insertSection: [[{ op: "insertSection", index: LIMITS.maxIndex + 1 }, "ops[0].index"]],
  removeNode: [[{ op: "removeNode" }, "ops[0].nodeId"]],
  moveNode: [[{ op: "moveNode", nodeId: "n_1", toSectionId: "", index: 0 }, "ops[0].toSectionId"]],
  setImage: [[{ op: "setImage", nodeId: "n_1", driveFileId: "m_1", alt: "x".repeat(LIMITS.maxAltLength + 1) }, "ops[0].alt"]],
};

describe("validateCommitRequest", () => {
  for (const [kind, op] of Object.entries(valid)) {
    test(`accepts a valid ${kind}`, () => {
      const result = validateCommitRequest({ baseRevisionId: "r1", ops: [op] });
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.deepEqual(result.ok && result.value.ops[0], op);
    });

    test(`refuses invalid ${kind} shapes with a field path`, () => {
      for (const [op, path] of invalid[kind]) {
        const result = validateCommitRequest({ baseRevisionId: "r1", ops: [op] });
        assert.equal(result.ok, false, JSON.stringify(op).slice(0, 120));
        assert.equal(!result.ok && result.path, path);
      }
    });
  }

  test("refuses an unknown op", () => {
    const result = validateCommitRequest({ baseRevisionId: "r1", ops: [{ op: "dropTable" }] });
    assert.deepEqual(result, { ok: false, path: "ops[0].op", error: "is not a known op" });
  });

  test("refuses a non-object body, bad envelope fields and extra keys", () => {
    assert.equal(!validateCommitRequest([]).ok && (validateCommitRequest([]) as { path: string }).path, "body");
    const cases: [unknown, string][] = [
      [{ baseRevisionId: 1, ops: [] }, "baseRevisionId"],
      [{ baseRevisionId: "r1", ops: "x" }, "ops"],
      [{ baseRevisionId: "r1", ops: [], extra: true }, "extra"],
      [{ baseRevisionId: "r1", ops: [null] }, "ops[0]"],
    ];
    for (const [body, path] of cases) {
      const result = validateCommitRequest(body);
      assert.equal(!result.ok && result.path, path, JSON.stringify(body));
    }
  });

  test("caps the number of ops", () => {
    const ops = Array(LIMITS.maxOps + 1).fill(valid.insertSection);
    const result = validateCommitRequest({ baseRevisionId: "r1", ops });
    assert.equal(!result.ok && result.path, "ops");
    assert.equal(validateCommitRequest({ baseRevisionId: "r1", ops: ops.slice(1) }).ok, true);
  });

  test("returns copies without unexpected fields", () => {
    const result = validateCommitRequest({ baseRevisionId: "r1", ops: [valid.replaceText] });
    assert.ok(result.ok && result.value.ops[0] !== valid.replaceText);
  });
});
