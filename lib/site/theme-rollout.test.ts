import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { closeDatabase, query, upsertUser } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import { createOrganization } from "@/lib/tenant/orgs";
import { bundledThemes, DEFAULT_THEME_NAME } from "@/lib/theme/registry";
import { tokenDefs } from "@/lib/theme/tokens";
import { advanceRollout, cancelRollout, createRollout, parseStages, readRollout, RolloutError } from "./theme-rollout";
import { NO_POLICY, saveOrgPolicy } from "./theme-policy";
import { readSiteTheme, renderContextFor } from "./theme-config";

describe("parseStages", () => {
  const allowed = new Set(["a", "b", "c"]);
  test("accepts disjoint stages of the organization's sites", () => {
    assert.deepEqual(parseStages([["a"], ["b", "c"]], allowed), [["a"], ["b", "c"]]);
  });
  test("refuses empty, repeated, foreign and oversized stages", () => {
    for (const input of [[], "x", [[]], [["a"], ["a"]], [["z"]], [[1]], Array.from({ length: 21 }, () => ["a"])]) {
      assert.throws(() => parseStages(input, allowed), RolloutError, JSON.stringify(input));
    }
  });
});

const url = testDatabaseUrl();
describe("staged theme rollout (#69)", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
    await upsertUser("ro-owner", "o@example.com");
  });
  after(async () => {
    await closeDatabase();
  });

  async function orgWithSites(count: number) {
    const org = await createOrganization("ro-owner", `Org ${randomBytes(3).toString("hex")}`);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = `site_${randomBytes(4).toString("hex")}`;
      await query("INSERT INTO sites (id, owner_sub, org_id) VALUES ($1, 'ro-owner', $2)", [id, org.id]);
      ids.push(id);
    }
    return { orgId: org.id, ids };
  }

  // A bundled theme other than the one new sites start on, so choosing it is a move.
  const otherTheme = () => bundledThemes().find((theme) => theme.manifest.name !== DEFAULT_THEME_NAME)?.manifest.name ?? "@pagefirst/editorial";
  const colorToken = async () => Object.entries(tokenDefs((await renderContextFor("ro-owner", "doc")).theme)).find(([, def]) => def.type === "color")![0];

  test("applies stage by stage, canary first, and completes", async () => {
    const { orgId, ids } = await orgWithSites(3);
    const token = await colorToken();
    const { rollout, problems } = await createRollout(orgId, { tokens: { [token]: "#123456" } }, [[ids[0]!], [ids[1]!, ids[2]!]], "ro-owner");
    assert.deepEqual(problems, {});
    assert.equal(rollout.status, "open");
    for (const id of ids) assert.equal((await readSiteTheme(id)).tokens[token], undefined, "nothing applied at planning");

    const first = await advanceRollout(orgId, rollout.id);
    assert.equal(first.status, "open");
    assert.equal(first.nextStage, 1);
    assert.equal((await readSiteTheme(ids[0]!)).tokens[token], "#123456");
    assert.equal((await readSiteTheme(ids[1]!)).tokens[token], undefined, "later stages wait");

    const second = await advanceRollout(orgId, rollout.id);
    assert.equal(second.status, "complete");
    for (const id of ids) assert.equal((await readSiteTheme(id)).tokens[token], "#123456");
    assert.deepEqual(Object.values(second.results).map((r) => r.status), ["applied", "applied", "applied"]);
    await assert.rejects(advanceRollout(orgId, rollout.id), /already complete/);
  });

  test("a site that refuses halts the rollout, and the retry skips sites already changed", async () => {
    const { orgId, ids } = await orgWithSites(2);
    const token = await colorToken();
    const { rollout } = await createRollout(orgId, { tokens: { [token]: "#abcdef" } }, [ids], "ro-owner");
    // Lock the token to another value after planning: both sites now refuse it.
    await saveOrgPolicy(orgId, { ...NO_POLICY, lockedTokens: { [token]: "#000000" } }, "ro-owner");
    const halted = await advanceRollout(orgId, rollout.id);
    assert.equal(halted.status, "halted");
    assert.equal(halted.nextStage, 0);
    assert.ok(Object.values(halted.results).every((r) => r.status === "failed" && /locked/.test(r.error ?? "")));
    // Remove the lock: the retry applies to both.
    await saveOrgPolicy(orgId, NO_POLICY, "ro-owner");
    const done = await advanceRollout(orgId, rollout.id);
    assert.equal(done.status, "complete");
    assert.equal((await readSiteTheme(ids[1]!)).tokens[token], "#abcdef");
  });

  test("planning refuses a change no site accepts, and names sites that would refuse it", async () => {
    const { orgId, ids } = await orgWithSites(2);
    await assert.rejects(createRollout(orgId, { themeName: "@nope/nothing" }, [ids], "ro-owner"), /can't be applied to any/);
    await saveOrgPolicy(orgId, { ...NO_POLICY, allowedThemes: ["@acme/only"] }, "ro-owner");
    await assert.rejects(createRollout(orgId, { themeName: otherTheme() }, [ids], "ro-owner"), /can't be applied to any/);
    await assert.rejects(createRollout(orgId, { tokens: {} }, [["site_not_mine"]], "ro-owner"), /not a site of this organization/);
  });

  test("a cancelled rollout stops; changed sites keep the change", async () => {
    const { orgId, ids } = await orgWithSites(2);
    const token = await colorToken();
    const { rollout } = await createRollout(orgId, { tokens: { [token]: "#101010" } }, [[ids[0]!], [ids[1]!]], "ro-owner");
    await advanceRollout(orgId, rollout.id);
    const cancelled = await cancelRollout(orgId, rollout.id);
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(advanceRollout(orgId, rollout.id), /already cancelled/);
    assert.equal((await readSiteTheme(ids[0]!)).tokens[token], "#101010");
    assert.equal((await readSiteTheme(ids[1]!)).tokens[token], undefined);
    assert.equal((await readRollout(orgId, rollout.id))?.status, "cancelled");
    await assert.rejects(cancelRollout(orgId, rollout.id), /already finished/);
    assert.equal(await readRollout("other-org", rollout.id), null, "another organization can't read it");
  });
});
