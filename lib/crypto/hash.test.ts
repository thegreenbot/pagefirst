import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { lookupDigest } from "./hash";

test("lookupDigest is deterministic per key, differs across keys, and needs the key", () => {
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  try {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const a = lookupDigest("pf_live_x");
    assert.equal(a, lookupDigest("pf_live_x"));
    assert.notEqual(a, lookupDigest("pf_live_y"));
    assert.match(a, /^[0-9a-f]{64}$/);
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    assert.notEqual(a, lookupDigest("pf_live_x"));
    delete process.env.TOKEN_ENCRYPTION_KEY;
    assert.throws(() => lookupDigest("x"), /TOKEN_ENCRYPTION_KEY/);
  } finally {
    if (saved === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = saved;
  }
});
