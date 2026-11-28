import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_HEADERS, appContentSecurityPolicy, createNonce } from "./headers";

describe("appContentSecurityPolicy", () => {
  test("allows scripts only with this request's nonce in production", () => {
    const policy = appContentSecurityPolicy("abc123");
    assert.match(policy, /script-src 'self' 'nonce-abc123' 'strict-dynamic'(;|$)/);
    assert.doesNotMatch(policy, /unsafe-eval/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.match(policy, /object-src 'none'/);
    assert.match(policy, /base-uri 'none'/);
  });

  test("allows the Google Picker only when it is configured", () => {
    const directives = (picker: boolean) => appContentSecurityPolicy("n", { picker }).split("; ");
    assert.ok(!directives(false).some((d) => d.startsWith("frame-src")));
    assert.ok(directives(true).includes("frame-src https://docs.google.com https://accounts.google.com"));
    assert.ok(directives(true).includes("connect-src 'self' https://apis.google.com"));
  });

  test("adds eval and websockets only for the dev server", () => {
    const policy = appContentSecurityPolicy("n", { dev: true });
    assert.match(policy, /'unsafe-eval'/);
    assert.match(policy, /connect-src 'self' ws:/);
  });
});

describe("createNonce", () => {
  test("returns a fresh base64 value each time", () => {
    const a = createNonce();
    assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(a, createNonce());
  });
});

describe("SECURITY_HEADERS", () => {
  test("covers HSTS, nosniff, referrer, framing and permissions", () => {
    const names = SECURITY_HEADERS.map((header) => header.key);
    for (const name of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options", "Permissions-Policy"]) {
      assert.ok(names.includes(name), name);
    }
  });
});
