import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { SITE_MANIFEST_PATH, deploymentForm, livePages, uploadToCloudflare } from "./cloudflare";
import { mayPublishPublicly, publishAllowlist } from "./allowlist";

const realFetch = globalThis.fetch;
type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function mockFetch(handler: Handler): { calls: { url: string; init?: RequestInit }[] } {
  const record = { calls: [] as { url: string; init?: RequestInit }[] };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    record.calls.push({ url: url.toString(), init });
    return handler(url, init);
  }) as typeof fetch;
  return record;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function manifestOf(form: FormData): Promise<Record<string, string>> {
  return JSON.parse(String(form.get("manifest")));
}

async function fileText(form: FormData, manifest: Record<string, string>, path: string): Promise<string> {
  const part = form.get(manifest[path]);
  assert.ok(part instanceof Blob, `no part for ${path}`);
  return part.text();
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("deploymentForm", () => {
  test("keeps carried pages, adds the new one and writes the page list", async () => {
    const carried = [{ path: "/about.html", bytes: new TextEncoder().encode("<p>about</p>"), type: "text/html" }];
    const form = deploymentForm(carried, "index.html", "<p>home</p>");
    const manifest = await manifestOf(form);
    assert.deepEqual(Object.keys(manifest).sort(), ["/_pagefirst/manifest.json", "/about.html", "/index.html"]);
    assert.equal(await fileText(form, manifest, "/about.html"), "<p>about</p>");
    assert.equal(await fileText(form, manifest, "/index.html"), "<p>home</p>");
    assert.deepEqual(JSON.parse(await fileText(form, manifest, SITE_MANIFEST_PATH)), {
      pages: ["/about.html", "/index.html"],
    });
  });

  test("a republished page replaces its old copy", async () => {
    const carried = [{ path: "/about.html", bytes: new TextEncoder().encode("old"), type: "text/html" }];
    const form = deploymentForm(carried, "about.html", "new");
    const manifest = await manifestOf(form);
    assert.equal(await fileText(form, manifest, "/about.html"), "new");
  });
});

describe("livePages", () => {
  test("reads every listed page from the live site", async () => {
    mockFetch((url) => {
      if (url.pathname === SITE_MANIFEST_PATH) return json({ pages: ["/a.html", "/b.html", "../etc/passwd", 5] });
      return new Response(`page ${url.pathname}`);
    });
    const pages = await livePages("page-first.pages.dev");
    assert.deepEqual(pages.map((page) => page.path), ["/a.html", "/b.html"]);
    assert.equal(new TextDecoder().decode(pages[1].bytes), "page /b.html");
  });

  test("a site without a page list carries nothing", async () => {
    mockFetch(() => new Response("missing", { status: 404 }));
    assert.deepEqual(await livePages("page-first.pages.dev"), []);
  });

  test("refuses to publish when a listed page cannot be read", async () => {
    mockFetch((url) => (url.pathname === SITE_MANIFEST_PATH ? json({ pages: ["/a.html"] }) : new Response("", { status: 500 })));
    await assert.rejects(livePages("page-first.pages.dev"), /Could not read live page/);
  });
});

describe("uploadToCloudflare", () => {
  const saved = { token: process.env.CLOUDFLARE_API_TOKEN, account: process.env.CLOUDFLARE_ACCOUNT_ID };
  beforeEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = "cf-test";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
  });
  afterEach(() => {
    process.env.CLOUDFLARE_API_TOKEN = saved.token;
    process.env.CLOUDFLARE_ACCOUNT_ID = saved.account;
  });

  test("a publish carries the site's other pages into the new deployment", async () => {
    let deployedForm: FormData | null = null;
    mockFetch(async (url, init) => {
      if (url.host === "api.cloudflare.com" && url.pathname.endsWith("/pages/projects/page-first")) {
        return json({ success: true, result: { subdomain: "page-first.pages.dev" } });
      }
      if (url.host === "page-first.pages.dev" && url.pathname === SITE_MANIFEST_PATH) return json({ pages: ["/about.html"] });
      if (url.host === "page-first.pages.dev") return new Response("<p>about</p>");
      if (url.pathname.endsWith("/deployments")) {
        deployedForm = init?.body as FormData;
        return json({ success: true, result: { url: "https://abc.page-first.pages.dev" } });
      }
      throw new Error(`unexpected ${url}`);
    });
    const url = await uploadToCloudflare("contact", "<p>contact</p>");
    assert.equal(url, "https://abc.page-first.pages.dev");
    assert.ok(deployedForm);
    const manifest = await manifestOf(deployedForm);
    assert.ok(manifest["/about.html"], "the other page survives");
    assert.ok(manifest["/contact.html"]);
  });

  test("ignores a subdomain that is not a pages.dev host", async () => {
    const calls = mockFetch(async (url) => {
      if (url.pathname.endsWith("/pages/projects/page-first")) return json({ success: true, result: { subdomain: "evil.example" } });
      if (url.pathname.endsWith("/deployments")) return json({ success: true, result: { url: "https://x.pages.dev" } });
      throw new Error(`unexpected ${url}`);
    });
    await uploadToCloudflare("index", "<p>x</p>");
    assert.ok(!calls.calls.some((call) => call.url.includes("evil.example")));
  });
});

describe("publish allow-list", () => {
  const saved = process.env.PUBLISH_ALLOWLIST;
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLISH_ALLOWLIST;
    else process.env.PUBLISH_ALLOWLIST = saved;
  });

  test("is empty, and refuses everyone, when unset", () => {
    delete process.env.PUBLISH_ALLOWLIST;
    assert.equal(publishAllowlist().size, 0);
    assert.equal(mayPublishPublicly("will@example.com"), false);
  });

  test("matches emails case-insensitively from a comma or space list", () => {
    process.env.PUBLISH_ALLOWLIST = " Will@Example.com,  ops@example.com not-an-email";
    assert.deepEqual([...publishAllowlist()].sort(), ["ops@example.com", "will@example.com"]);
    assert.equal(mayPublishPublicly("WILL@example.com"), true);
    assert.equal(mayPublishPublicly("other@example.com"), false);
    assert.equal(mayPublishPublicly(null), false);
  });
});
