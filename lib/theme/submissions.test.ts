import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { isSystemAdmin } from "@/lib/admin/system";
import { invitePublisher, listPublishers, PublisherError, publisherRepositoryFor, revokePublisher } from "./publishers";
import { readThemeDir } from "./package";
import { RegistryError, latestVersion } from "./registry-store";
import { approveSubmission, listSubmissions, rejectSubmission, ReviewError, submitVersion } from "./submissions";
import { packTheme } from "./tarball";
import { checkPublisher, checkAttestation, type OidcClaims } from "./trusted-publishing";

const url = testDatabaseUrl();

function archiveAs(name: string, edit?: (files: Map<string, Uint8Array>) => void): Uint8Array {
  const files = readThemeDir("themes/default");
  const manifest = JSON.parse(new TextDecoder().decode(files.get("theme.json")));
  manifest.name = name;
  files.set("theme.json", new TextEncoder().encode(JSON.stringify(manifest)));
  edit?.(files);
  return packTheme(files);
}

describe("system administrators", () => {
  test("come only from the environment", () => {
    process.env.PAGEFIRST_SYSTEM_ADMINS = " a1 ,b2";
    assert.ok(isSystemAdmin("a1") && isSystemAdmin("b2"));
    assert.ok(!isSystemAdmin("c3") && !isSystemAdmin(null) && !isSystemAdmin(""));
    delete process.env.PAGEFIRST_SYSTEM_ADMINS;
    assert.ok(!isSystemAdmin("a1"));
  });
});

describe("trusted publishing for invited scopes", () => {
  const claims = (repository: string, tag: string): OidcClaims => ({
    iss: "", aud: "", exp: 0, repository, ref: `refs/tags/${tag}`, ref_type: "tag", sha: "s", event_name: "push",
    job_workflow_ref: `${repository}/.github/workflows/theme-publish.yml@refs/tags/${tag}`, run_id: "1",
  });
  test("accepts the invited repository's workflow on the matching tag", () => {
    assert.doesNotThrow(() => checkPublisher(claims("acme/themes", "theme-aurora-v1.0.0"), "@acme/aurora", "1.0.0", "acme/themes"));
  });
  test("refuses another repository, a wrong tag, and the first-party repository for an outside scope", () => {
    assert.throws(() => checkPublisher(claims("evil/themes", "theme-aurora-v1.0.0"), "@acme/aurora", "1.0.0", "acme/themes"), /Only acme\/themes/);
    assert.throws(() => checkPublisher(claims("acme/themes", "theme-aurora-v1.0.1"), "@acme/aurora", "1.0.0", "acme/themes"), /tag/);
    assert.throws(() => checkPublisher(claims("thegreenbot/pagefirst", "theme-aurora-v1.0.0"), "@acme/aurora", "1.0.0"), /invited publishers/);
  });
  test("an invited repository can't claim @pagefirst names", () => {
    assert.doesNotThrow(() => checkPublisher(claims("thegreenbot/pagefirst", "theme-x-v1.0.0"), "@pagefirst/x", "1.0.0"));
    assert.throws(() => checkAttestation({}, new Uint8Array(), "plain", "1.0.0", "acme/themes"));
  });
});

describe("theme publishers and submissions (#68)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
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

  test("invites bind a scope to one repository and reserve first-party and organization scopes", async () => {
    const publisher = await invitePublisher("acme", "Acme/Themes", "admin-sub");
    assert.equal(publisher.repository, "acme/themes");
    assert.equal(await publisherRepositoryFor("@acme/aurora"), "acme/themes");
    assert.equal(await publisherRepositoryFor("@other/aurora"), null);
    assert.equal(await publisherRepositoryFor("aurora"), null);
    await assert.rejects(invitePublisher("pagefirst", "x/y", "a"), /reserved/);
    await assert.rejects(invitePublisher("org-abc123def456", "x/y", "a"), /reserved/);
    await assert.rejects(invitePublisher("acme", "x/y", "a"), PublisherError);
    await assert.rejects(invitePublisher("other", "acme/themes", "a"), /already taken/);
    await assert.rejects(invitePublisher("Bad Slug", "x/y", "a"), PublisherError);
  });

  test("a version that fails the sandbox is refused and nothing is stored", async () => {
    const bad = archiveAs("@acme/bad", (files) => {
      files.set("layouts/page.liquid", new TextEncoder().encode("<script>eval('1')</script>"));
    });
    await assert.rejects(submitVersion(bad, { repository: "acme/themes" }, "acme"), RegistryError);
    assert.equal((await listSubmissions(null)).length, 0);
  });

  test("a scope can't submit under another scope's name", async () => {
    await assert.rejects(submitVersion(archiveAs("@someone/else"), {}, "acme"), /outside your scope/);
  });

  test("a passing version waits unlisted until approved, then lists as verified with the reviewer recorded", async () => {
    const queued = await submitVersion(archiveAs("@acme/aurora"), { repository: "acme/themes" }, "acme");
    assert.equal(queued.status, "pending");
    assert.deepEqual(queued.report.findings, []);
    assert.equal(await latestVersion("@acme/aurora"), null);
    await assert.rejects(submitVersion(archiveAs("@acme/aurora"), {}, "acme"), /already waiting/);
    const published = await approveSubmission(queued.id, "admin-sub");
    assert.equal(published.tier, "verified");
    assert.equal((await latestVersion("@acme/aurora"))?.tier, "verified");
    const stored = await query<{ provenance: { review?: { by: string } } }>("SELECT provenance FROM theme_versions WHERE name = '@acme/aurora'");
    assert.equal(stored[0]!.provenance.review?.by, "admin-sub");
    await assert.rejects(approveSubmission(queued.id, "admin-sub"), ReviewError);
    await assert.rejects(submitVersion(archiveAs("@acme/aurora"), {}, "acme"), /already published/);
  });

  test("a rejection keeps the reason, lists nothing, and lets the publisher resubmit", async () => {
    const queued = await submitVersion(archiveAs("@acme/dusk"), {}, "acme");
    await assert.rejects(rejectSubmission(queued.id, "admin-sub", "  "), /Say why/);
    await rejectSubmission(queued.id, "admin-sub", "Too similar to Editorial");
    await assert.rejects(approveSubmission(queued.id, "admin-sub"), /already rejected/);
    assert.equal(await latestVersion("@acme/dusk"), null);
    assert.equal((await listSubmissions("rejected"))[0]?.reason, "Too similar to Editorial");
    assert.equal((await submitVersion(archiveAs("@acme/dusk"), {}, "acme")).status, "pending");
  });

  test("a revoked publisher can no longer submit, and a scope can't be reused", async () => {
    assert.ok(await revokePublisher("acme"));
    assert.equal(await publisherRepositoryFor("@acme/aurora"), null);
    assert.ok(!(await revokePublisher("acme")));
    assert.equal((await listPublishers())[0]?.revokedAt !== null, true);
    await assert.rejects(invitePublisher("acme", "acme/new", "a"), /already taken/);
  });
});
