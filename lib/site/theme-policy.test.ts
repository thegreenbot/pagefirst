import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { orgIdForSite } from "@/lib/tenant/orgs";
import { bundledThemes } from "@/lib/theme/registry";
import { tokenDefs } from "@/lib/theme/tokens";
import { budgetWarnings, checkThemeUpdate, NO_POLICY, parsePolicy, readSitePolicy, saveOrgPolicy, withLockedTokens } from "./theme-policy";
import { ConfigError, readSiteTheme, renderContextFor, siteForOwner, updateSiteTheme, type SiteThemeConfig } from "./theme-config";

const config = (over: Partial<SiteThemeConfig> = {}): SiteThemeConfig => ({
  themeName: "@pagefirst/default",
  versionRange: "^1.0.0",
  tokens: {},
  settings: {},
  customCss: "",
  templateOverrides: {},
  locks: [],
  lock: { version: "1.0.0", integrity: "sha256-abc" },
  ...over,
});

describe("parsePolicy", () => {
  test("accepts a full policy and defaults the rest", () => {
    assert.deepEqual(parsePolicy({}), NO_POLICY);
    assert.deepEqual(parsePolicy({ lockedTokens: { "color-brand": "#123456", scale: 1.2 }, allowedThemes: ["@acme/site", "@acme/site"], requireSigned: true }), {
      lockedTokens: { "color-brand": "#123456", scale: 1.2 },
      allowedThemes: ["@acme/site"],
      requireSigned: true,
      blockOnBudget: false,
    });
  });
  test("refuses bad shapes", () => {
    for (const body of [null, [], { lockedTokens: [] }, { lockedTokens: { Bad: "x" } }, { lockedTokens: { a: "x;y" } }, { lockedTokens: { a: {} } }, { allowedThemes: "x" }, { allowedThemes: ["nope"] }, { requireSigned: "yes" }]) {
      assert.throws(() => parsePolicy(body), ConfigError, JSON.stringify(body));
    }
  });
});

describe("checkThemeUpdate", () => {
  const policy = { ...NO_POLICY, lockedTokens: { "color-brand": "#111111" }, allowedThemes: ["@acme/site"] };
  test("a locked token can't be changed, but is fine when unchanged or unset", () => {
    const current = config({ tokens: { "color-brand": "#999999" } });
    assert.throws(() => checkThemeUpdate(policy, current, config({ allowedThemes: undefined, tokens: { "color-brand": "#222222" } } as never)), /locked/);
    checkThemeUpdate({ ...policy, allowedThemes: null }, current, config({ tokens: { "color-brand": "#999999" } }));
    checkThemeUpdate({ ...policy, allowedThemes: null }, current, config({ tokens: { "color-brand": "#111111" } }));
    checkThemeUpdate({ ...policy, allowedThemes: null }, current, config({ tokens: {} }));
  });
  test("moving to a theme off the list is refused; staying put is not", () => {
    assert.throws(() => checkThemeUpdate(policy, config(), config({ themeName: "@other/theme" })), /allowed themes/);
    checkThemeUpdate(policy, config({ themeName: "@other/theme" }), config({ themeName: "@other/theme" }));
    checkThemeUpdate(policy, config(), config({ themeName: "@acme/site" }));
  });
  test("signed-only accepts registry versions and bundled themes, refuses the rest", () => {
    const signedOnly = { ...NO_POLICY, requireSigned: true };
    checkThemeUpdate(signedOnly, config(), config({ lock: { version: "2.0.0", integrity: "sha512-xyz" }, themeName: "@acme/site" }));
    checkThemeUpdate(signedOnly, config(), config({ themeName: bundledThemes()[0]!.manifest.name, lock: { version: "2.0.0", integrity: "sha256-q" } }));
    assert.throws(() => checkThemeUpdate(signedOnly, config(), config({ themeName: "@acme/unsigned", lock: { version: "2.0.0", integrity: "sha256-q" } })), /signed/);
  });
  test("withLockedTokens overlays the lock, budgetWarnings finds budget messages", () => {
    assert.deepEqual(withLockedTokens(config({ tokens: { a: 1, b: 2 } }), { ...NO_POLICY, lockedTokens: { b: 3 } }).tokens, { a: 1, b: 3 });
    assert.deepEqual(budgetWarnings(["Critical CSS is 10 bytes over its 14000 byte budget", "other"]), ["Critical CSS is 10 bytes over its 14000 byte budget"]);
  });
});

const url = testDatabaseUrl();
describe("organization theme policy (#69)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("a brand lock applies to every site of the organization and can't be overridden", async () => {
    const siteId = await siteForOwner("gov-owner");
    const orgId = (await orgIdForSite(siteId))!;
    const theme = (await renderContextFor("gov-owner", "doc")).theme;
    const token = Object.entries(tokenDefs(theme)).find(([, def]) => def.type === "color")?.[0];
    assert.ok(token, "the default theme has a color token");
    await saveOrgPolicy(orgId, { ...NO_POLICY, lockedTokens: { [token!]: "#0a0a0a" } }, "gov-owner");
    assert.equal((await readSitePolicy(siteId)).lockedTokens[token!], "#0a0a0a");
    // The site stored nothing, yet renders with the locked value.
    assert.equal((await renderContextFor("gov-owner", "doc")).config!.tokens[token!], "#0a0a0a");
    await assert.rejects(updateSiteTheme(siteId, { tokens: { [token!]: "#ffffff" } }), /locked by your organization/);
    // Other tokens still change freely.
    const other = Object.entries(tokenDefs(theme)).find(([name, def]) => name !== token && def.type === "color")?.[0];
    if (other) await updateSiteTheme(siteId, { tokens: { [other]: "#abcdef" } });
    assert.equal((await readSiteTheme(siteId)).tokens[token!], undefined);
  });

  test("an allowed-theme list stops a switch to a theme off the list", async () => {
    const siteId = await siteForOwner("gov-owner-2");
    const orgId = (await orgIdForSite(siteId))!;
    const other = bundledThemes().find((t) => t.manifest.name !== (bundledThemes()[0]!.manifest.name))?.manifest.name;
    await saveOrgPolicy(orgId, { ...NO_POLICY, allowedThemes: ["@acme/private"] }, "gov-owner-2");
    if (other) await assert.rejects(updateSiteTheme(siteId, { themeName: other }), /allowed themes/);
    await saveOrgPolicy(orgId, NO_POLICY, "gov-owner-2");
    if (other) await updateSiteTheme(siteId, { themeName: other });
    const rows = await query<{ n: string }>("SELECT count(*) AS n FROM org_theme_policy WHERE org_id = $1", [orgId]);
    assert.equal(rows[0]!.n, "1");
  });
});
