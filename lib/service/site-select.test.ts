import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { publishToOwnSite, publishToSite } from "@/lib/publish/sites";
import { addMember, createOrganization } from "@/lib/tenant/orgs";
import { ServiceError, type ServiceContext } from "./context";
import { applySiteHeader } from "./site-select";

const url = testDatabaseUrl();
const realFetch = globalThis.fetch;

const ctxFor = (sub: string | null): ServiceContext => ({ actor: { sub, client: "api" }, googleToken: "t", requestId: "r" });
const withHeader = (site?: string) => new Request("http://x/", { headers: site ? { "X-Pagefirst-Site": site } : {} });
const code = (expected: string) => (error: unknown) => error instanceof ServiceError && error.code === expected;

describe("publishing to an organization site (#45)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  let orgSite = "";
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
    process.env.PUBLISH_DOMAIN = "sites.example";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
    process.env.R2_BUCKET = "pagefirst-sites";
    process.env.R2_API_TOKEN = "r2-token";
  });
  beforeEach(async () => {
    await query("DELETE FROM sites");
    await query("DELETE FROM organizations");
    await query("DELETE FROM users");
    for (const sub of ["owner", "editor", "viewer", "stranger"]) await upsertUser(sub, `${sub}@example.com`);
    const org = await createOrganization("owner", "Acme");
    await addMember(org.id, "editor", "editor");
    await addMember(org.id, "viewer", "viewer");
    orgSite = `site_${randomBytes(6).toString("hex")}`;
    await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ($1, 'owner', $2)", [orgSite, org.id]);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });
  after(async () => {
    for (const name of ["PUBLISH_DOMAIN", "CLOUDFLARE_ACCOUNT_ID", "R2_BUCKET", "R2_API_TOKEN"]) delete process.env[name];
    await closeDatabase();
  });

  test("no header leaves the context alone", async () => {
    const ctx = ctxFor("editor");
    await applySiteHeader(ctx, withHeader());
    assert.equal(ctx.siteId, undefined);
  });

  test("an editor may select the organization's site; a viewer is refused; a stranger sees nothing", async () => {
    const editor = ctxFor("editor");
    await applySiteHeader(editor, withHeader(orgSite));
    assert.equal(editor.siteId, orgSite);
    await assert.rejects(applySiteHeader(ctxFor("viewer"), withHeader(orgSite)), code("forbidden"));
    await assert.rejects(applySiteHeader(ctxFor("stranger"), withHeader(orgSite)), code("not_found"));
    await assert.rejects(applySiteHeader(ctxFor("editor"), withHeader("../etc")), code("not_found"));
    await assert.rejects(applySiteHeader(ctxFor(null), withHeader(orgSite)), code("not_found"));
  });

  test("a page published to the organization's site lands on its own address, not the publisher's personal site", async () => {
    const puts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") puts.push(decodeURIComponent(new URL(String(input)).pathname));
      return new Response("{}");
    }) as typeof fetch;
    const page = { html: "<p>hi</p>", csp: "default-src 'none'", assets: [] };
    const org = await publishToSite(orgSite, "about", page);
    const personal = await publishToOwnSite("editor", "about", page);
    assert.equal(org.siteId, orgSite);
    assert.notEqual(personal.siteId, orgSite);
    assert.notEqual(org.url, personal.url);
    assert.ok(puts.some((key) => key.includes(orgSite)));
  });
});
