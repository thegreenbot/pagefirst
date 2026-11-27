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
  {
    id: 2,
    name: "sessions and google tokens",
    sql: `
      CREATE TABLE sessions (
        id_hash      text PRIMARY KEY,
        sub          text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        user_agent   text,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sessions_sub_idx ON sessions (sub);

      CREATE TABLE google_tokens (
        sub                  text PRIMARY KEY REFERENCES users(sub) ON DELETE CASCADE,
        refresh_token_sealed text NOT NULL,
        access_token_sealed  text,
        access_expires_at    timestamptz,
        scopes               text NOT NULL DEFAULT '',
        created_at           timestamptz NOT NULL DEFAULT now(),
        last_used_at         timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
];
