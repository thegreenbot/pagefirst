import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, publicLookup, validateWebhookUrl } from "./public-host";

describe("public host checks", () => {
  test("refuses private, loopback, link-local and reserved addresses", () => {
    for (const bad of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fe80::1", "fc00::1", "::ffff:10.0.0.1", "not-an-ip"]) {
      assert.equal(isPublicAddress(bad), false, bad);
    }
    for (const good of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      assert.equal(isPublicAddress(good), true, good);
    }
  });

  test("accepts only https URLs on a public-looking hostname", () => {
    assert.equal(validateWebhookUrl("https://hooks.example.com/pagefirst").hostname, "hooks.example.com");
    for (const bad of ["http://hooks.example.com/", "https://127.0.0.1/", "https://[::1]/", "https://localhost/", "https://intranet/", "https://svc.internal/", "https://a.example.com:8443/", "https://user:pw@a.example.com/", "ftp://a.example.com/", "nonsense", 42]) {
      assert.throws(() => validateWebhookUrl(bad), Error, String(bad));
    }
  });

  test("the connect-time lookup refuses a name that resolves to a private address", async () => {
    const result = await new Promise<Error | null>((resolve) => publicLookup("localhost", {}, (error) => resolve(error)));
    assert.ok(result, "localhost resolves to loopback and must be refused");
  });
});
