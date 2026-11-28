import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkInstance } from "./instance-check.mjs";

const example = () => JSON.parse(readFileSync(new URL("../infra/instance/instance.example.json", import.meta.url), "utf8"));

test("the shipped example config is valid", () => {
  assert.deepEqual(checkInstance(example()), []);
});

test("secrets in the file are rejected", () => {
  const errors = checkInstance({ ...example(), google_client_secret: "x" });
  assert.ok(errors.some((e) => e.includes("TF_VAR_google_client_secret")));
});

test("missing, unknown and malformed settings are reported", () => {
  const rest = example();
  delete rest.name;
  const errors = checkInstance({ ...rest, cloudflare_zone_id: "nope", surprise: 1, git_ref: "develop", pagefirst_version: "0.2" });
  assert.ok(errors.includes("name is required"));
  assert.ok(errors.some((e) => e.startsWith("cloudflare_zone_id")));
  assert.ok(errors.includes("unknown setting surprise"));
  assert.ok(errors.some((e) => e.startsWith("git_ref")));
  assert.ok(errors.some((e) => e.startsWith("pagefirst_version")));
});

test("app and publish domains must differ", () => {
  const c = example();
  assert.ok(checkInstance({ ...c, publish_domain: c.app_domain }).some((e) => e.includes("must differ")));
});

test("non-objects are rejected", () => {
  assert.deepEqual(checkInstance([]), ["config must be a JSON object"]);
});
