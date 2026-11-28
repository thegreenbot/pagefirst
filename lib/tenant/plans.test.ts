import assert from "node:assert/strict";
import test from "node:test";
import { PlanError, featureAllowed, gatingEnabled, planIncludes } from "./plans";

function withEdition<T>(value: string | undefined, run: () => T): T {
  const saved = process.env.PAGEFIRST_EDITION;
  if (value === undefined) delete process.env.PAGEFIRST_EDITION;
  else process.env.PAGEFIRST_EDITION = value;
  try {
    return run();
  } finally {
    if (saved === undefined) delete process.env.PAGEFIRST_EDITION;
    else process.env.PAGEFIRST_EDITION = saved;
  }
}

test("free has no custom CSS or template overrides; every paid plan has both", () => {
  assert.equal(planIncludes("free", "customCss"), false);
  assert.equal(planIncludes("free", "templateOverrides"), false);
  for (const plan of ["pro", "team", "enterprise"] as const) {
    assert.equal(planIncludes(plan, "customCss"), true);
    assert.equal(planIncludes(plan, "templateOverrides"), true);
  }
});

test("hosted gates by plan", () => {
  withEdition("hosted", () => {
    assert.equal(gatingEnabled(), true);
    assert.equal(featureAllowed("free", "customCss"), false);
    assert.equal(featureAllowed("pro", "customCss"), true);
  });
});

test("self-hosted, the default, is never gated", () => {
  for (const value of [undefined, "", "self-hosted"]) {
    withEdition(value, () => {
      assert.equal(gatingEnabled(), false);
      assert.equal(featureAllowed("free", "customCss"), true);
    });
  }
});

test("PlanError is a 402 that names the feature", () => {
  const error = new PlanError("customCss");
  assert.equal(error.status, 402);
  assert.match(error.message, /Custom CSS/);
});
