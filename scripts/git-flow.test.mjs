import assert from "node:assert/strict";
import test from "node:test";
import { branchName, checkPushLine, tagName } from "./git-flow.mjs";

test("feature, cursor, release, and hotfix names are accepted", () => {
  for (const name of [
    "feature/git-flow",
    "feature/add-oauth",
    "cursor/git-flow-cf41",
    "release/v0.1.0",
    "release/v1.2.3-rc.1",
    "hotfix/v1.2.4",
  ]) {
    assert.equal(branchName.test(name), true, name);
  }
});

test("branches outside git-flow are rejected", () => {
  for (const name of ["main", "develop", "wip", "feature/Bad", "release/1.2.3", "release/v1.2", "hotfix/v01.2.3"]) {
    assert.equal(branchName.test(name), false, name);
  }
});

test("tags are vMAJOR.MINOR.PATCH", () => {
  assert.equal(tagName.test("v0.1.0"), true);
  assert.equal(tagName.test("v1.2.3-rc.1"), true);
  assert.equal(tagName.test("1.2.3"), false);
  assert.equal(tagName.test("v1.2"), false);
});

test("protected branches cannot be pushed or deleted", () => {
  const zero = "0".repeat(40);
  const sha = "a".repeat(40);
  assert.equal(checkPushLine(`refs/heads/cursor/git-flow-cf41 ${sha} refs/heads/main ${zero}`).ok, false);
  assert.equal(checkPushLine(`refs/heads/develop ${zero} refs/heads/develop ${sha}`).ok, false);
  assert.equal(checkPushLine(`refs/heads/feature/docs ${sha} refs/heads/develop ${zero}`).ok, false);
});

test("other branches and semver tags follow the push rules", () => {
  const zero = "0".repeat(40);
  const sha = "b".repeat(40);
  assert.equal(checkPushLine(`refs/heads/feature/docs ${sha} refs/heads/feature/docs ${zero}`).ok, true);
  assert.equal(checkPushLine(`refs/heads/wip ${sha} refs/heads/wip ${zero}`).ok, false);
  assert.equal(checkPushLine(`refs/heads/feature/docs ${zero} refs/heads/feature/docs ${sha}`).ok, true);
  assert.equal(checkPushLine(`refs/tags/v1.2.3 ${sha} refs/tags/v1.2.3 ${zero}`).ok, true);
  assert.equal(checkPushLine(`refs/tags/latest ${sha} refs/tags/latest ${zero}`).ok, false);
  assert.equal(checkPushLine(`refs/tags/v1.2.3 ${zero} refs/tags/v1.2.3 ${sha}`).ok, false);
  assert.equal(checkPushLine(`refs/tags/v1.2.3 ${sha} refs/tags/v1.2.3 ${"c".repeat(40)}`).ok, false);
});
