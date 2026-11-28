import assert from "node:assert/strict";
import test from "node:test";
import { isApex, normalizeHostname, withinLimits } from "./hostname";

const rules = { publishDomain: "pagefirst.io", reserved: ["app.pagefirst.com"] };

test("accepts and normalizes valid hostnames", () => {
  const cases: [string, string][] = [
    ["www.example.com", "www.example.com"],
    ["  WWW.Example.COM. ", "www.example.com"],
    ["docs.acme.co.uk", "docs.acme.co.uk"],
    ["bücher.example.de", "xn--bcher-kva.example.de"],
    ["a-b.example.org", "a-b.example.org"],
  ];
  for (const [input, expected] of cases) assert.deepEqual(normalizeHostname(input, rules), { ok: true, hostname: expected }, input);
});

test("rejects malformed input", () => {
  const bad = [
    "", "   ", "example", "https://www.example.com", "www.example.com/path", "www.example.com:8080",
    "*.example.com", "my_site.example.com", "-a.example.com", "a-.example.com", "a..example.com",
    "192.168.0.1", "1.2.3.4", "[::1]", `${"a".repeat(64)}.example.com`, "www.example.123", "user@example.com",
  ];
  for (const input of bad) assert.equal(normalizeHostname(input, rules).ok, false, input);
});

test("rejects the publish domain, reserved hosts, internal names and public suffixes", () => {
  const bad = ["pagefirst.io", "mine.pagefirst.io", "a.b.pagefirst.io", "PAGEFIRST.IO", "app.pagefirst.com", "x.app.pagefirst.com", "localhost.localdomain", "printer.local", "api.internal", "foo.test", "co.uk", "com.au"];
  for (const input of bad) assert.equal(normalizeHostname(input, rules).ok, false, input);
});

test("rules are optional", () => {
  assert.equal(normalizeHostname("mine.pagefirst.io").ok, true);
});

test("isApex distinguishes registrable domains from subdomains", () => {
  assert.equal(isApex("example.com"), true);
  assert.equal(isApex("acme.co.uk"), true);
  assert.equal(isApex("www.example.com"), false);
  assert.equal(isApex("www.acme.co.uk"), false);
});

test("withinLimits checks the site then the account", () => {
  assert.deepEqual(withinLimits({ site: 0, account: 0 }, { perSite: 1, perAccount: 5 }), { ok: true });
  assert.equal(withinLimits({ site: 1, account: 1 }, { perSite: 1, perAccount: 5 }).ok, false);
  assert.equal(withinLimits({ site: 0, account: 5 }, { perSite: 1, perAccount: 5 }).ok, false);
});
