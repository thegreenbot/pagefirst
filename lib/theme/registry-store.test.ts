import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import { renderPageHtml } from "@/lib/page/render";
import { availableThemes, readSiteTheme, renderContextFor, siteForOwner, updateSiteTheme } from "@/lib/site/theme-config";
import { readThemeDir } from "./package";
import { orgIdForSite } from "@/lib/tenant/orgs";
import { clearVerifiedCache, setTier, tierOfIntegrity, latestVersion, listThemes, loadVerifiedVersion, privateScope, publishVersion, resolveVersion, yankVersion } from "./registry-store";
import { archiveIntegrity, packTheme } from "./tarball";

const url = testDatabaseUrl();
const provenance = { publisher: "test" };

function archiveOf(dir: string, edit?: (manifest: Record<string, unknown>) => void): Uint8Array {
  const files = readThemeDir(dir);
  if (edit) {
    const manifest = JSON.parse(new TextDecoder().decode(files.get("theme.json")));
    edit(manifest);
    files.set("theme.json", new TextEncoder().encode(JSON.stringify(manifest)));
  }
  return packTheme(files);
}

describe("theme registry (#64)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    process.env.THEME_REGISTRY_SIGNING_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.THEME_REGISTRY_PUBLIC_KEYS = publicKey.export({ type: "spki", format: "pem" }).toString();
  });
  after(async () => {
    delete process.env.THEME_REGISTRY_SIGNING_KEY;
    delete process.env.THEME_REGISTRY_PUBLIC_KEYS;
    await closeDatabase();
  });

  test("publishes two first-party themes, checked and countersigned", async () => {
    const def = await publishVersion(archiveOf("themes/default"), provenance, { performance: 100 });
    const ed = await publishVersion(archiveOf("themes/editorial"), provenance);
    assert.equal(def.integrity, archiveIntegrity(archiveOf("themes/default")));
    assert.deepEqual((await listThemes()).map((t) => `${t.name}@${t.version}`), ["@pagefirst/default@1.0.0", "@pagefirst/editorial@1.0.0"]);
    assert.ok(Object.keys(ed.budgets).includes("every-block"));
    assert.deepEqual(def.scores, { performance: 100 });
  });

  test("the editor's theme list comes from the registry", async () => {
    assert.deepEqual(
      (await availableThemes()).map((t) => [t.name, t.version, t.source]),
      [
        ["@pagefirst/default", "1.0.0", "registry"],
        ["@pagefirst/editorial", "1.0.0", "registry"],
      ],
    );
  });

  test("a version cannot be published twice, even with different bytes", async () => {
    await assert.rejects(publishVersion(archiveOf("themes/editorial", (m) => (m.description = "changed")), provenance), /already published; versions are immutable/);
  });

  test("an invalid archive or an over-budget theme is refused", async () => {
    await assert.rejects(publishVersion(new TextEncoder().encode("junk"), provenance), /not a valid theme/);
    await assert.rejects(publishVersion(archiveOf("themes/editorial", (m) => { m.version = "1.0.1"; m.budgets = { htmlKb: 0.1 }; }), provenance), /over budget/);
    assert.equal(await resolveVersion("@pagefirst/editorial", "1.0.1"), null);
  });

  test("a site switches between the two themes from the registry", async () => {
    const site = await siteForOwner("reg-owner");
    const first = await readSiteTheme(site);
    assert.equal(first.lock.integrity, (await latestVersion("@pagefirst/default"))!.integrity, "a new site locks to the registry version");

    const switched = await updateSiteTheme(site, { themeName: "@pagefirst/editorial" });
    assert.equal(switched.versionRange, "^1.0.0");
    assert.equal(switched.lock.integrity, (await latestVersion("@pagefirst/editorial"))!.integrity);
    const page = aboutFixture();
    let html = renderPageHtml(page, "publish", await renderContextFor("reg-owner", page.fileId)).html;
    assert.match(html, /class="masthead"/);

    await updateSiteTheme(site, { themeName: "@pagefirst/default" });
    html = renderPageHtml(page, "publish", await renderContextFor("reg-owner", page.fileId)).html;
    assert.doesNotMatch(html, /masthead/);
    assert.match(html, /Source Serif 4/);
  });

  test("an unknown theme is refused", async () => {
    const site = await siteForOwner("reg-owner");
    await assert.rejects(updateSiteTheme(site, { themeName: "@someone/else" }), /not an available theme/);
  });

  test("published versions cannot be rewritten or deleted", async () => {
    const version = (await latestVersion("@pagefirst/editorial"))!;
    await assert.rejects(query("UPDATE theme_versions SET archive = $2 WHERE integrity = $1", [version.integrity, Buffer.from("x")]), /immutable/);
    await assert.rejects(query("UPDATE theme_versions SET countersignature = 'x' WHERE integrity = $1", [version.integrity]), /immutable/);
    await assert.rejects(query("DELETE FROM theme_versions WHERE integrity = $1", [version.integrity]), /immutable/);
  });

  test("a tampered archive fails verification and does not render", async () => {
    const site = await siteForOwner("tamper-owner");
    const config = await updateSiteTheme(site, { themeName: "@pagefirst/editorial" });
    // Simulate storage tampering below the app: bypass the immutability trigger as the database owner.
    const evil = archiveOf("themes/editorial", (m) => (m.description = "evil"));
    await query("ALTER TABLE theme_versions DISABLE TRIGGER theme_versions_no_rewrite");
    try {
      await query("UPDATE theme_versions SET archive = $2 WHERE integrity = $1", [config.lock.integrity, Buffer.from(evil)]);
    } finally {
      await query("ALTER TABLE theme_versions ENABLE TRIGGER theme_versions_no_rewrite");
    }
    clearVerifiedCache();
    await assert.rejects(renderContextFor("tamper-owner", "about"), /archive does not match its integrity; refusing to render/);
  });

  test("a version without a valid registry signature does not render", async () => {
    const archive = archiveOf("themes/editorial", (m) => (m.version = "2.0.0"));
    const integrity = archiveIntegrity(archive);
    await query(
      `INSERT INTO theme_versions (name, version, integrity, archive, manifest, budgets, provenance, countersignature)
       VALUES ('@pagefirst/editorial', '2.0.0', $1, $2, '{}', '{}', '{}', 'AAAA')`,
      [integrity, Buffer.from(archive)],
    );
    await assert.rejects(loadVerifiedVersion(integrity), /registry signature is missing or invalid/);
  });

  test("yanking stops new locks but sites already locked keep rendering", async () => {
    const def = (await latestVersion("@pagefirst/default"))!;
    const site = await siteForOwner("yank-owner");
    await readSiteTheme(site);
    const next = await publishVersion(archiveOf("themes/default", (m) => (m.version = "1.1.0")), provenance);
    await yankVersion("@pagefirst/default", "1.1.0", "Breaks the hero on Safari");
    assert.equal((await resolveVersion("@pagefirst/default", "^1.0.0"))!.version, "1.0.0");
    const yanked = (await (await import("./registry-store")).listVersions("@pagefirst/default")).find((v) => v.version === "1.1.0")!;
    assert.equal(yanked.yanked, true);
    assert.equal(yanked.advisory, "Breaks the hero on Safari");
    clearVerifiedCache();
    assert.equal((await renderContextFor("yank-owner", "about")).theme.manifest.version, def.version);
    assert.notEqual(next.integrity, def.integrity);
  });

  test("a private theme is listed and installable only for its organization's sites (#69)", async () => {
    const siteA = await siteForOwner("private-a");
    const siteB = await siteForOwner("private-b");
    const orgA = (await orgIdForSite(siteA))!;
    const name = `@${privateScope(orgA)}/brand`;
    const archive = archiveOf("themes/default", (m) => {
      m.name = name;
      m.version = "1.0.0";
    });
    const published = await publishVersion(archive, { source: "org-upload" }, null, undefined, orgA);
    assert.equal(published.name, name);

    assert.ok(!(await listThemes()).some((t) => t.name === name), "not in the public listing");
    assert.ok((await listThemes(orgA)).some((t) => t.name === name), "in its owner's");
    assert.equal(await resolveVersion(name, "^1.0.0"), null);
    assert.equal((await resolveVersion(name, "^1.0.0", orgA))?.version, "1.0.0");
    assert.ok((await availableThemes(siteA)).some((t) => t.name === name));
    assert.ok(!(await availableThemes(siteB)).some((t) => t.name === name));

    await updateSiteTheme(siteA, { themeName: name });
    assert.equal((await readSiteTheme(siteA)).themeName, name);
    await assert.rejects(updateSiteTheme(siteB, { themeName: name }), /not an available theme/);
    // It keeps rendering for its owner after other themes change.
    assert.ok((await renderContextFor("private-a", "doc")).theme.manifest.name === name);
  });

  test("a name can't be claimed both publicly and privately", async () => {
    const orgA = (await orgIdForSite(await siteForOwner("private-a")))!;
    await assert.rejects(publishVersion(archiveOf("themes/default", (m) => (m.version = "9.9.9")), provenance, null, undefined, orgA), /belongs to another publisher/);
  });

  test("a community theme needs an explicit confirmation to install; a promoted one doesn't (#68)", async () => {
    const siteId = await siteForOwner("community-owner");
    const name = "@acme/community";
    const archive = archiveOf("themes/default", (m) => {
      m.name = name;
      m.version = "1.0.0";
    });
    const published = await publishVersion(archive, { source: "test" }, null, undefined, null, "community");
    assert.equal(published.tier, "community");
    assert.equal((await availableThemes(siteId)).find((t) => t.name === name)?.tier, "community");
    await assert.rejects(updateSiteTheme(siteId, { themeName: name }), /unreviewed community theme/);
    await assert.rejects(updateSiteTheme(siteId, { themeName: name, acceptUnreviewed: false }), /unreviewed community theme/);
    await updateSiteTheme(siteId, { themeName: name, acceptUnreviewed: true });
    assert.equal((await readSiteTheme(siteId)).themeName, name);

    const other = await siteForOwner("community-owner-2");
    await setTier(name, "1.0.0", "verified");
    assert.equal(await tierOfIntegrity(published.integrity), "verified");
    await updateSiteTheme(other, { themeName: name });
    await assert.rejects(setTier(name, "1.0.0", "private"), /can't become private/);
  });

  test("a version that breaks a submission check is refused (#68)", async () => {
    const files = readThemeDir("themes/default");
    const manifest = JSON.parse(new TextDecoder().decode(files.get("theme.json")));
    manifest.name = "@acme/sneaky";
    files.set("theme.json", new TextEncoder().encode(JSON.stringify(manifest)));
    const base = files.get("blocks/hero/block.css");
    files.set("blocks/hero/block.css", new TextEncoder().encode(`@import url("https://evil.example/x.css");${base ? new TextDecoder().decode(base) : ""}`));
    await assert.rejects(publishVersion(packTheme(files), provenance, null, undefined, null, "community"), /failed the submission checks.*no-css-import/);
  });
});
