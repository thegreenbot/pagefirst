import assert from "node:assert/strict";
import test from "node:test";
import { cloudflareSaasConfig, createCloudflareSaasProvider, mapCustomHostname } from "./cloudflare-saas";
import { createFakeProvider } from "./fake-provider";
import { configuredDomainProvider } from "./index";
import { createManualProvider } from "./manual-provider";
import { ProviderError } from "./provider";

const config = { zoneId: "zone1", token: "secret-token", cnameTarget: "domains.pagefirst.io" };

type Call = { method: string; url: string; body: unknown; auth: string | null };

function fakeFetch(handler: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: String(init?.method),
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: new Headers(init?.headers).get("authorization"),
    };
    calls.push(call);
    const out = handler(call);
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status });
  }) as typeof fetch;
  return { calls, impl };
}

test("cloudflare config needs zone, token and target", () => {
  assert.deepEqual(cloudflareSaasConfig({ CLOUDFLARE_SAAS_ZONE_ID: "z", CLOUDFLARE_SAAS_API_TOKEN: "t", CUSTOM_DOMAIN_CNAME_TARGET: "Domains.Example.IO." }), { zoneId: "z", token: "t", cnameTarget: "domains.example.io" });
  assert.equal(cloudflareSaasConfig({ CLOUDFLARE_SAAS_ZONE_ID: "z" }), null);
});

test("add registers the hostname with HTTP DV and returns the CNAME and ownership records", async () => {
  const { calls, impl } = fakeFetch(() => ({
    status: 200,
    body: {
      result: {
        id: "ch-1",
        status: "pending",
        ownership_verification: { type: "txt", name: "_cf-custom-hostname.www.acme.com", value: "abc" },
        ssl: { status: "initializing" },
      },
    },
  }));
  const provider = createCloudflareSaasProvider(config, impl);
  const added = await provider.add("www.acme.com", "tok");
  assert.equal(added.ref, "ch-1");
  assert.equal(added.state, "pending");
  assert.deepEqual(added.records.map((r) => [r.type, r.name, r.value, r.purpose]), [
    ["CNAME", "www.acme.com", "domains.pagefirst.io", "route"],
    ["TXT", "_cf-custom-hostname.www.acme.com", "abc", "ownership"],
  ]);
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.url, "https://api.cloudflare.com/client/v4/zones/zone1/custom_hostnames");
  assert.equal(calls[0]!.auth, "Bearer secret-token");
  assert.deepEqual(calls[0]!.body, { hostname: "www.acme.com", ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } } });
});

test("a retry of an already registered hostname finds the existing one", async () => {
  const { impl } = fakeFetch((call) =>
    call.method === "POST" ? { status: 409 } : { status: 200, body: { result: [{ id: "ch-9", status: "pending", ssl: { status: "pending_validation" } }] } },
  );
  const added = await createCloudflareSaasProvider(config, impl).add("www.acme.com", "tok");
  assert.equal(added.ref, "ch-9");
});

test("a conflict with no hostname to find, and other failures, throw a body-free ProviderError", async () => {
  const conflict = fakeFetch((call) => (call.method === "POST" ? { status: 409 } : { status: 200, body: { result: [] } }));
  await assert.rejects(createCloudflareSaasProvider(config, conflict.impl).add("a.acme.com", "t"), (e) => e instanceof ProviderError && e.status === 409);
  const broken = fakeFetch(() => ({ status: 500, body: { errors: [{ message: "secret-token leaked?" }] } }));
  await assert.rejects(createCloudflareSaasProvider(config, broken.impl).add("a.acme.com", "t"), (e) => e instanceof ProviderError && e.message === "Domain provider answered 500" && !e.message.includes("secret"));
});

test("status maps Cloudflare states", () => {
  const map = (result: object) => mapCustomHostname("www.acme.com", "domains.pagefirst.io", result);
  assert.equal(map({ status: "active", ssl: { status: "active" } }).state, "active");
  assert.deepEqual(map({ status: "active", ssl: { status: "active" } }).records, []);
  assert.equal(map({ status: "pending", ssl: { status: "initializing" } }).state, "pending");
  assert.equal(map({ status: "active", ssl: { status: "pending_validation", validation_records: [{ txt_name: "_acme.www.acme.com", txt_value: "v" }] } }).state, "verifying");
  assert.equal(map({ status: "blocked", ssl: {} }).state, "error");
  assert.equal(map({ status: "moved", ssl: {} }).state, "error");
  assert.equal(map({ status: "pending", ssl: { status: "validation_timed_out" } }).state, "error");
});

test("status of a missing hostname is an error the owner can act on; remove tolerates 404", async () => {
  const gone = fakeFetch(() => ({ status: 404 }));
  const provider = createCloudflareSaasProvider(config, gone.impl);
  assert.equal((await provider.status("ch-1", "www.acme.com", "t")).state, "error");
  await provider.remove("ch-1");
  assert.equal(gone.calls[1]!.method, "DELETE");
  const bad = fakeFetch(() => ({ status: 403 }));
  await assert.rejects(createCloudflareSaasProvider(config, bad.impl).remove("ch-1"), ProviderError);
  await assert.rejects(createCloudflareSaasProvider(config, bad.impl).status("ch-1", "www.acme.com", "t"), ProviderError);
});

test("manual provider is active only when both the CNAME and the TXT token are in DNS", async () => {
  let cname: string[] = [];
  let txt: string[][] = [];
  const provider = createManualProvider("Domains.Example.io.", {
    resolveCname: async () => cname,
    resolveTxt: async () => txt,
  });
  const first = await provider.add("www.acme.com", "tok123");
  assert.equal(first.ref, "www.acme.com");
  assert.equal(first.state, "pending");
  assert.deepEqual(first.records.map((r) => r.name), ["www.acme.com", "_pagefirst-challenge.www.acme.com"]);
  cname = ["domains.example.io."];
  const half = await provider.status("www.acme.com", "www.acme.com", "tok123");
  assert.equal(half.state, "pending");
  assert.deepEqual(half.records.map((r) => r.purpose), ["ownership"]);
  txt = [["to", "k123"]];
  assert.equal((await provider.status("www.acme.com", "www.acme.com", "tok123")).state, "active");
  txt = [["wrong"]];
  assert.equal((await provider.status("www.acme.com", "www.acme.com", "tok123")).state, "pending");
  await provider.remove("www.acme.com");
});

test("manual provider treats DNS lookup failures as not there yet", async () => {
  const provider = createManualProvider("domains.example.io", {
    resolveCname: async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); },
    resolveTxt: async () => { throw Object.assign(new Error("ENODATA"), { code: "ENODATA" }); },
  });
  assert.equal((await provider.status("x", "www.acme.com", "t")).state, "pending");
});

test("fake provider is idempotent per hostname and can be driven", async () => {
  const fake = createFakeProvider();
  const a = await fake.add("www.acme.com", "t");
  assert.equal((await fake.add("www.acme.com", "t")).ref, a.ref);
  fake.set(a.ref, { state: "active", message: null, records: [] });
  assert.equal((await fake.status(a.ref, "www.acme.com", "t")).state, "active");
  await fake.remove(a.ref);
  assert.deepEqual(fake.removed, [a.ref]);
  assert.equal((await fake.status(a.ref, "www.acme.com", "t")).state, "error");
  assert.throws(() => fake.set("nope", {}));
});

test("configuredDomainProvider picks by DOMAIN_PROVIDER and returns null when unset or incomplete", () => {
  assert.equal(configuredDomainProvider({}), null);
  assert.equal(configuredDomainProvider({ DOMAIN_PROVIDER: "cloudflare-saas" }), null);
  assert.equal(configuredDomainProvider({ DOMAIN_PROVIDER: "manual" }), null);
  assert.equal(configuredDomainProvider({ DOMAIN_PROVIDER: "manual", CUSTOM_DOMAIN_CNAME_TARGET: "d.example.io" })?.name, "manual");
  assert.equal(
    configuredDomainProvider({ DOMAIN_PROVIDER: "cloudflare-saas", CLOUDFLARE_SAAS_ZONE_ID: "z", CLOUDFLARE_SAAS_API_TOKEN: "t", CUSTOM_DOMAIN_CNAME_TARGET: "d.example.io" })?.name,
    "cloudflare-saas",
  );
});
