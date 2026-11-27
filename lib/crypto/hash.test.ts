import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { hashSecret } from "./hash";

test("hashSecret is deterministic per key, differs across keys, and needs the key", () => {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const a = hashSecret("pf_live_x");
    assert.equal(a, hashSecret("pf_live_x"));
    assert.notEqual(a, hashSecret("pf_live_y"));
    assert.match(a, /^[0-9a-f]{64}$/);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.notEqual(a, hashSecret("pf_live_x"));
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => hashSecret("x"), /TOKEN_ENCRYPTION_KEY/);
  } finally {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
});
