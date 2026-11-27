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
  {
    id: 9,
    name: "theme registry versions",
    sql: `
      -- Published theme versions (#64). A version is immutable once written:
      -- only its yank time and advisory can change, and it is never deleted.
      CREATE TABLE theme_versions (
        name              text NOT NULL,
        version           text NOT NULL,
        integrity         text NOT NULL UNIQUE,
        archive           bytea NOT NULL,
        manifest          jsonb NOT NULL,
        budgets           jsonb NOT NULL,
        scores            jsonb,
        provenance        jsonb NOT NULL,
        countersignature  text NOT NULL,
        published_at      timestamptz NOT NULL DEFAULT now(),
        yanked_at         timestamptz,
        advisory          text,
        PRIMARY KEY (name, version)
      );

      CREATE FUNCTION theme_versions_immutable() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'UPDATE'
          AND NEW.name = OLD.name AND NEW.version = OLD.version AND NEW.integrity = OLD.integrity
          AND NEW.archive = OLD.archive AND NEW.manifest = OLD.manifest AND NEW.budgets = OLD.budgets
          AND NEW.scores IS NOT DISTINCT FROM OLD.scores AND NEW.provenance = OLD.provenance
          AND NEW.countersignature = OLD.countersignature AND NEW.published_at = OLD.published_at THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'theme versions are immutable; only yanked_at and advisory can change';
      END;
      $fn$;
      CREATE TRIGGER theme_versions_no_rewrite
        BEFORE UPDATE OR DELETE ON theme_versions
        FOR EACH ROW EXECUTE FUNCTION theme_versions_immutable();
      CREATE TRIGGER theme_versions_no_truncate
        BEFORE TRUNCATE ON theme_versions
        FOR EACH STATEMENT EXECUTE FUNCTION theme_versions_immutable();

      -- A lock now points at a registry version (sha512-) or, for bundled
      -- themes and older locks, a package snapshot (sha256-).
      ALTER TABLE site_themes DROP CONSTRAINT site_themes_locked_integrity_fkey;
    `,
  },
  {
    id: 10,
    name: "site pages and theme change previews",
    sql: `
      -- Each page a site has published (#66): what a theme change previews and
      -- what applying it republishes.
      CREATE TABLE site_pages (
        site_id      text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        file_id      text NOT NULL,
        path         text NOT NULL,
        revision_id  text,
        published_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, file_id)
      );
      CREATE INDEX site_pages_recent_idx ON site_pages (site_id, published_at DESC);

      -- A dry run of a theme change: the change, the lock it was measured
      -- against, and the report. Applying checks the site has not moved on.
      CREATE TABLE theme_change_previews (
        id          text PRIMARY KEY,
        site_id     text NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        change      jsonb NOT NULL,
        from_config jsonb NOT NULL,
        to_config   jsonb NOT NULL,
        report      jsonb NOT NULL,
        status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'discarded')),
        created_at  timestamptz NOT NULL DEFAULT now(),
        resolved_at timestamptz
      );
      CREATE INDEX theme_change_previews_site_idx ON theme_change_previews (site_id, created_at DESC);
    `,
  },
  {
    id: 11,
    name: "api keys",
    sql: `
      -- Scoped credentials for scripts and agents (#36). The key itself is never
      -- stored, only its SHA-256, so a database leak cannot be replayed.
      CREATE TABLE api_keys (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sub          text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        name         text NOT NULL,
        key_prefix   text NOT NULL,
        key_hash     text NOT NULL UNIQUE,
        scopes       text[] NOT NULL,
        site_folders text[],
        expires_at   timestamptz NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at   timestamptz
      );
      CREATE INDEX api_keys_sub_idx ON api_keys (sub, created_at DESC);
    `,
  },
  {
    id: 12,
    name: "oauth 2.1 server for MCP clients",
    sql: `
      -- Pagefirst as an OAuth authorization server (#36, ADR 0003). Secrets are
      -- stored as SHA-256 only. Clients are public (PKCE, no client secret).
      CREATE TABLE oauth_clients (
        client_id     text PRIMARY KEY,
        name          text NOT NULL,
        redirect_uris text[] NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE oauth_codes (
        code_hash      text PRIMARY KEY,
        client_id      text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        sub            text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        scopes         text[] NOT NULL,
        code_challenge text NOT NULL,
        redirect_uri   text NOT NULL,
        expires_at     timestamptz NOT NULL,
        used_at        timestamptz
      );

      CREATE TABLE oauth_tokens (
        token_hash text PRIMARY KEY,
        kind       text NOT NULL CHECK (kind IN ('access', 'refresh')),
        family_id  uuid NOT NULL,
        client_id  text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
        sub        text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        scopes     text[] NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        used_at    timestamptz,
        revoked_at timestamptz
      );
      CREATE INDEX oauth_tokens_family_idx ON oauth_tokens (family_id);
      CREATE INDEX oauth_tokens_sub_idx ON oauth_tokens (sub);
    `,
  },
];
