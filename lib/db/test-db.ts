/**
 * Test helper: points DATABASE_URL at a fresh schema-less database named by
 * TEST_DATABASE_URL. Tests that need Postgres call `useTestDatabase()`; CI
 * always sets TEST_DATABASE_URL, and a missing one fails there instead of skipping.
 */
import { closeDatabase } from "./client";
import { Client } from "pg";

export function testDatabaseUrl(): string | null {
  const url = process.env.TEST_DATABASE_URL?.trim();
  if (url) return url;
  if (process.env.CI) throw new Error("TEST_DATABASE_URL must be set in CI");
  return null;
}

/** Drops every table so each test file starts from an empty schema. */
export async function resetTestDatabase(url: string): Promise<void> {
  await closeDatabase();
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  } finally {
    await client.end();
  }
  process.env.DATABASE_URL = url;
}
