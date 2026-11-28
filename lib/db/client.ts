import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { MIGRATIONS } from "./migrations";

/**
 * Postgres (Neon in production, see docs/adr/0001-persistent-store.md).
 * Everything that needs the database checks `databaseConfigured()` first, so
 * the app still runs without DATABASE_URL, the way it did before #10.
 */

type DbGlobal = { pool?: Pool; migrated?: Promise<void> };
const state = globalThis as typeof globalThis & { __pagefirstDb?: DbGlobal };
const db = (state.__pagefirstDb ??= {});

export function databaseUrl(): string | null {
  const value = process.env.DATABASE_URL?.trim();
  return value ? value : null;
}

export function databaseConfigured(): boolean {
  return databaseUrl() !== null;
}

function pool(): Pool {
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!db.pool) {
    db.pool = new Pool({
      connectionString: url,
      // Serverless functions are short-lived; Neon's pooler does the real pooling.
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return db.pool;
}

/** Arbitrary constant for pg_advisory_lock so two instances never migrate at once. */
const MIGRATION_LOCK = 72_640_001;

async function runMigrations(): Promise<void> {
  const client = await pool().connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id integer PRIMARY KEY,
         name text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ id: number }>("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.id));
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [migration.id, migration.name]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/** Applies pending migrations once per process. */
export function migrate(): Promise<void> {
  if (!db.migrated) {
    db.migrated = runMigrations().catch((error) => {
      db.migrated = undefined;
      throw error;
    });
  }
  return db.migrated;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T[]> {
  await migrate();
  const result = await pool().query<T>(text, values);
  return result.rows;
}

/** Runs `work` in one transaction on one connection. */
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  await migrate();
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** For tests: closes the pool and forgets migration state. */
export async function closeDatabase(): Promise<void> {
  const current = db.pool;
  db.pool = undefined;
  db.migrated = undefined;
  await current?.end();
}

/** Records that a Google account signed in. */
/** `hd` is the Workspace domain at sign-in; omit it to leave the stored value alone. */
export async function upsertUser(sub: string, email: string | null, hd?: string | null): Promise<void> {
  await query(
    `INSERT INTO users (sub, email, hd) VALUES ($1, $2, $3)
     ON CONFLICT (sub) DO UPDATE SET email = EXCLUDED.email,
       hd = CASE WHEN $4 THEN EXCLUDED.hd ELSE users.hd END, last_seen_at = now()`,
    [sub, email, hd ?? null, hd !== undefined],
  );
}
