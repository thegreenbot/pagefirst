import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cloudflareSaasConfig, createCloudflareSaasProvider } from "./cloudflare-saas";

/**
 * Talks to the real Cloudflare for SaaS API on a throwaway test zone (#192).
 * Skipped unless CUSTOM_DOMAIN_E2E_HOSTNAME names a hostname on that zone and
 * the CLOUDFLARE_SAAS_* variables point at it. It registers the hostname,
 * reads its status and DNS records, then removes it, leaving nothing behind.
 */
const hostname = process.env.CUSTOM_DOMAIN_E2E_HOSTNAME?.trim().toLowerCase();
const config = cloudflareSaasConfig(process.env);

describe("custom domains against Cloudflare for SaaS", { skip: hostname && config ? false : "set CUSTOM_DOMAIN_E2E_HOSTNAME and the CLOUDFLARE_SAAS_* variables to run" }, () => {
  test("add, read status, list and remove a hostname", async () => {
    const provider = createCloudflareSaasProvider(config!);
    const added = await provider.add(hostname!, "e2e-token");
    try {
      assert.ok(added.ref);
      assert.ok(added.records.some((record) => record.type === "CNAME" && record.name === hostname));
      const status = await provider.status(added.ref, hostname!, "e2e-token");
      assert.ok(["pending", "verifying", "active"].includes(status.state));
      assert.ok((await provider.list!()).some((entry) => entry.ref === added.ref));
    } finally {
      await provider.remove(added.ref);
    }
    assert.ok(!(await provider.list!()).some((entry) => entry.ref === added.ref));
  });
});
