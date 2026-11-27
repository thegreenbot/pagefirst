/**
 * Ordered schema migrations. Append new entries; never edit or reorder one
 * that has shipped. Each runs once, inside a transaction.
 */
export type Migration = { id: number; name: string; sql: string };

export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: "users",
    sql: `
      CREATE TABLE users (
        sub          text PRIMARY KEY,
        email        text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
