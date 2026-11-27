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
  {
    id: 3,
    name: "append-only audit events",
    sql: `
      CREATE TABLE audit_events (
        id                 bigserial PRIMARY KEY,
        at                 timestamptz NOT NULL DEFAULT now(),
        request_id         text,
        actor_sub          text,
        actor_key          text NOT NULL DEFAULT 'ui',
        client             text NOT NULL DEFAULT 'ui' CHECK (client IN ('ui', 'api', 'mcp')),
        event              text NOT NULL,
        file_id            text,
        base_revision_id   text,
        result_revision_id text,
        op_count           integer,
        op_kinds           text[],
        outcome            text NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
        status             integer,
        error_code         text,
        idempotency_key    text,
        ip_hash            text
      );
      CREATE INDEX audit_events_actor_idx ON audit_events (actor_sub, at DESC);
      CREATE INDEX audit_events_file_idx ON audit_events (file_id, at DESC);

      -- History cannot be changed by the app. Retention deletes set
      -- pagefirst.audit_maintenance = 'on' for their own transaction only.
      CREATE FUNCTION audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('pagefirst.audit_maintenance', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_events is append-only';
      END;
      $fn$;
      CREATE TRIGGER audit_events_no_update_delete
        BEFORE UPDATE OR DELETE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();
      CREATE TRIGGER audit_events_no_truncate
        BEFORE TRUNCATE ON audit_events
        FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
    `,
  },
];
