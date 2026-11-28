import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { aboutFixture } from "@/lib/page/fixture";
import { renderPageHtml } from "@/lib/page/render";
import { availableThemes, readSiteTheme, renderContextFor, siteForOwner, updateSiteTheme } from "@/lib/site/theme-config";
import { readThemeDir } from "./package";
import { clearVerifiedCache, latestVersion, listThemes, loadVerifiedVersion, publishVersion, resolveVersion, yankVersion } from "./registry-store";
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
});
