import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./log";

describe("redact", () => {
  test("removes given secrets, server secrets and Google token shapes", () => {
    const saved = process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_CLIENT_SECRET = "client-secret-value";
    const text = redact(
      "token my-token-123 secret client-secret-value bearer ya29.a0AfB_xyz refresh 1//0gAbcdefghijklmnopqrstuvwxyz",
      "my-token-123",
    );
    assert.equal(text, "token [redacted] secret [redacted] bearer [redacted] refresh [redacted]");
    if (saved === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = saved;
  });

  test("ignores empty and very short values so it never mangles ordinary text", () => {
    assert.equal(redact("a b c", "", null, undefined, "a"), "a b c");
  });
});
