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
  {
    id: 4,
    name: "shared rate limits, previews and media",
    sql: `
      -- Counters are disposable, so skip the write-ahead log.
      CREATE UNLOGGED TABLE rate_limits (
        key          text NOT NULL,
        window_start bigint NOT NULL,
        count        integer NOT NULL,
        PRIMARY KEY (key, window_start)
      );

      CREATE TABLE previews (
        file_id     text PRIMARY KEY,
        revision_id text,
        html        text NOT NULL,
        -- Per-page CSP for the theme engine (#54); null means the default policy.
        csp         text,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE media (
        id         text PRIMARY KEY,
        owner_key  text NOT NULL,
        mime       text NOT NULL,
        bytes      bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX media_owner_idx ON media (owner_key, created_at);
    `,
  },
  {
    id: 5,
    name: "sites and site theme config",
    sql: `
      -- Minimal site identity (#56). #94 adds hostname and publish target columns.
      CREATE TABLE sites (
        id         text PRIMARY KEY,
        owner_sub  text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sites_owner_idx ON sites (owner_sub, created_at);

      -- Immutable theme package snapshots, addressed by integrity hash, so a
      -- site's lock keeps rendering with the same bytes after an app deploy.
      CREATE TABLE theme_packages (
        integrity  text PRIMARY KEY,
        name       text NOT NULL,
        version    text NOT NULL,
        package    jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      -- Presentation lives in the app, never in the Doc (#56).
      CREATE TABLE site_themes (
        site_id            text PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        theme_name         text NOT NULL,
        version_range      text NOT NULL,
        tokens             jsonb NOT NULL DEFAULT '{}',
        settings           jsonb NOT NULL DEFAULT '{}',
        custom_css         text NOT NULL DEFAULT '',
        template_overrides jsonb NOT NULL DEFAULT '{}',
        locks              jsonb NOT NULL DEFAULT '[]',
        locked_version     text NOT NULL,
        locked_integrity   text NOT NULL REFERENCES theme_packages(integrity),
        updated_at         timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE page_presentation (
        site_id        text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        file_id        text NOT NULL,
        template       text NOT NULL DEFAULT 'page',
        section_styles jsonb NOT NULL DEFAULT '{}',
        updated_at     timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, file_id)
      );
    `,
  },
  {
    id: 6,
    name: "site hostnames and publish audit",
    sql: `
      -- Each site's label under PUBLISH_DOMAIN (#94), assigned on first public publish.
      ALTER TABLE sites ADD COLUMN subdomain text UNIQUE;
      ALTER TABLE audit_events ADD COLUMN site_id text, ADD COLUMN page_path text;
    `,
  },
  {
    id: 7,
    name: "image renditions per site",
    sql: `
      -- Image renditions already uploaded to a site (#61), keyed by a hash of the
      -- source bytes, so republishing an unchanged image encodes and uploads nothing.
      CREATE TABLE image_renditions (
        site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        source_hash text NOT NULL,
        width       integer NOT NULL CHECK (width > 0),
        height      integer NOT NULL CHECK (height > 0),
        widths      integer[] NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, source_hash)
      );
    `,
  },
  {
    id: 8,
    name: "files already on each site",
    sql: `
      -- What each site's bucket folder holds (#63), so republishing an unchanged
      -- page or asset uploads nothing. key is the path inside the site's folder,
      -- or host:<hostname> for the hostname record.
      CREATE TABLE site_files (
        site_id    text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        key        text NOT NULL,
        sha256     text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, key)
      );
    `,
  },
];
