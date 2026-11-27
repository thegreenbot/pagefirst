import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { closeDatabase, databaseConfigured, migrate, query, transaction, upsertUser } from "./client";
import { MIGRATIONS } from "./migrations";
import { resetTestDatabase, testDatabaseUrl } from "./test-db";

const url = testDatabaseUrl();

describe("database client", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    await resetTestDatabase(url!);
  });
  after(async () => {
    await closeDatabase();
  });

  test("applies every migration once, even when called concurrently", async () => {
    await Promise.all([migrate(), migrate(), migrate()]);
    const rows = await query<{ id: number }>("SELECT id FROM schema_migrations ORDER BY id");
    assert.deepEqual(rows.map((row) => row.id), MIGRATIONS.map((m) => m.id));
  });

  test("a second process starting later re-applies nothing", async () => {
    await closeDatabase();
    process.env.DATABASE_URL = url!;
    await migrate();
    const rows = await query<{ count: string }>("SELECT count(*) FROM schema_migrations");
    assert.equal(Number(rows[0].count), MIGRATIONS.length);
  });

  test("upsertUser inserts then updates the email", async () => {
    await upsertUser("sub-1", "a@example.com");
    await upsertUser("sub-1", "b@example.com");
    const rows = await query<{ email: string }>("SELECT email FROM users WHERE sub = $1", ["sub-1"]);
    assert.deepEqual(rows, [{ email: "b@example.com" }]);
  });

  test("transaction rolls back on error", async () => {
    await assert.rejects(
      transaction(async (client) => {
        await client.query("INSERT INTO users (sub) VALUES ('rolled-back')");
        throw new Error("boom");
      }),
      /boom/,
    );
    const rows = await query("SELECT 1 FROM users WHERE sub = 'rolled-back'");
    assert.equal(rows.length, 0);
  });
});

describe("databaseConfigured", () => {
  test("follows DATABASE_URL", () => {
    const saved = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "  ";
    assert.equal(databaseConfigured(), false);
    process.env.DATABASE_URL = "postgres://x";
    assert.equal(databaseConfigured(), true);
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  });
});
