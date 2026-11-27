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
      -- stored, only a keyed hash, so a database leak cannot be replayed.
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
      -- stored only as a keyed hash. Clients are public (PKCE, no client secret).
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
  {
    id: 13,
    name: "organizations, members, roles and plans",
    sql: `
      -- The tenant boundary for the hosted service (#45). Every site belongs to
      -- one organization, and an organization carries the plan that gates paid
      -- features (#65). Existing sites move into a personal organization.
      CREATE TABLE organizations (
        id         text PRIMARY KEY,
        name       text NOT NULL,
        plan       text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE org_members (
        org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        sub        text NOT NULL REFERENCES users(sub) ON DELETE CASCADE,
        role       text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, sub)
      );
      CREATE INDEX org_members_sub_idx ON org_members (sub);

      ALTER TABLE sites ADD COLUMN org_id text REFERENCES organizations(id) ON DELETE CASCADE;

      -- One personal organization per existing site owner.
      INSERT INTO organizations (id, name)
        SELECT 'org_' || md5(owner_sub), 'Personal' FROM (SELECT DISTINCT owner_sub FROM sites) o;
      INSERT INTO org_members (org_id, sub, role)
        SELECT 'org_' || md5(owner_sub), owner_sub, 'owner' FROM (SELECT DISTINCT owner_sub FROM sites) o;
      UPDATE sites SET org_id = 'org_' || md5(owner_sub);
      ALTER TABLE sites ALTER COLUMN org_id SET NOT NULL;
      CREATE INDEX sites_org_idx ON sites (org_id);
    `,
  },
  {
    id: 14,
    name: "idempotency keys",
    sql: `
      -- (credential, key) -> what the first request did, kept 24 hours (#38).
      CREATE TABLE idempotency_keys (
        credential_id   text NOT NULL,
        key             text NOT NULL,
        request_hash    text NOT NULL,
        state           text NOT NULL CHECK (state IN ('in_progress', 'done')),
        response_status integer,
        response_body   text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
        PRIMARY KEY (credential_id, key)
      );
      CREATE INDEX idempotency_keys_expires_idx ON idempotency_keys (expires_at);
    `,
  },
  {
    id: 15,
    name: "content audit decisions",
    sql: `
      -- Append-only history of what a person decided about a flagged page (#50).
      CREATE TABLE content_audit_decisions (
        id          bigserial PRIMARY KEY,
        file_id     text NOT NULL,
        actor_sub   text,
        finding     text NOT NULL CHECK (finding IN ('stale', 'expired', 'thin', 'duplicate')),
        decision    text NOT NULL CHECK (decision IN ('keep', 'update', 'merge', 'rewrite', 'noindex', 'remove')),
        note        text NOT NULL DEFAULT '',
        revision_id text,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX content_audit_decisions_file_idx ON content_audit_decisions (file_id, created_at DESC);
    `,
  },
  {
    id: 16,
    name: "billing: stripe subscriptions per organization",
    sql: `
      -- One Stripe customer and at most one live subscription per organization (#47).
      CREATE TABLE org_billing (
        org_id                 text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        stripe_customer_id     text NOT NULL UNIQUE,
        stripe_subscription_id text UNIQUE,
        status                 text,
        plan                   text CHECK (plan IN ('pro', 'team')),
        billing_interval       text CHECK (billing_interval IN ('month', 'year')),
        seats                  integer,
        current_period_end     timestamptz,
        updated_at             timestamptz NOT NULL DEFAULT now()
      );

      -- Stripe retries webhooks; each event id is handled once.
      CREATE TABLE stripe_events (
        id          text PRIMARY KEY,
        type        text NOT NULL,
        received_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: 17,
    name: "google workspace domain lock and pending memberships",
    sql: `
      -- The Google Workspace domain (hd claim) of the account, recorded at sign-in (#49).
      ALTER TABLE users ADD COLUMN hd text;

      -- When set, only accounts whose hd equals it can use the organization.
      ALTER TABLE organizations ADD COLUMN enforced_domain text;

      -- Membership granted before the person has signed in (an invite or a SCIM
      -- provisioning), claimed when a verified Google email matches.
      CREATE TABLE org_pending_members (
        org_id     text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        email      text NOT NULL CHECK (email = lower(email)),
        role       text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
        source     text NOT NULL DEFAULT 'invite',
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, email)
      );
      CREATE INDEX org_pending_members_email_idx ON org_pending_members (email);
    `,
  },
  {
    id: 18,
    name: "scim tokens and provisioned users",
    sql: `
      -- Per-organization bearer tokens for an identity provider's SCIM client (#49).
      CREATE TABLE scim_tokens (
        id           text PRIMARY KEY,
        org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        label        text NOT NULL,
        token_prefix text NOT NULL,
        token_hash   text NOT NULL UNIQUE,
        created_by   text REFERENCES users(sub) ON DELETE SET NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at   timestamptz
      );
      CREATE INDEX scim_tokens_org_idx ON scim_tokens (org_id);

      -- What the identity provider has told us about each person. Membership itself
      -- lives in org_members (or org_pending_members until the person signs in).
      CREATE TABLE scim_users (
        id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id       text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_name    text NOT NULL CHECK (user_name = lower(user_name)),
        external_id  text,
        display_name text,
        given_name   text,
        family_name  text,
        active       boolean NOT NULL DEFAULT true,
        role         text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
        sub          text REFERENCES users(sub) ON DELETE SET NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, user_name)
      );
      CREATE INDEX scim_users_org_role_idx ON scim_users (org_id, role);
    `,
  },
  {
    id: 20,
    name: "bulk jobs",
    sql: `
      -- Background jobs run as a credential's owner (#40). Progress lives here, so
      -- a job survives a process restart and resumes where it stopped.
      CREATE TABLE jobs (
        id               text PRIMARY KEY,
        credential_id    text NOT NULL,
        sub              text NOT NULL,
        scopes           text[] NOT NULL,
        site_folders     text[],
        kind             text NOT NULL CHECK (kind IN ('commit', 'publish', 'import', 'import_and_publish')),
        status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'cancelled')),
        dry_run          boolean NOT NULL DEFAULT false,
        policy           jsonb NOT NULL DEFAULT '{}',
        cancel_requested boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        started_at       timestamptz,
        finished_at      timestamptz
      );
      CREATE INDEX jobs_credential_idx ON jobs (credential_id, created_at DESC);

      CREATE TABLE job_items (
        job_id      text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        idx         integer NOT NULL,
        file_id     text NOT NULL,
        params      jsonb NOT NULL DEFAULT '{}',
        status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'ok', 'skipped', 'conflict', 'error', 'cancelled')),
        code        text,
        message     text,
        result      jsonb,
        attempts    integer NOT NULL DEFAULT 0,
        started_at  timestamptz,
        finished_at timestamptz,
        PRIMARY KEY (job_id, idx)
      );
      CREATE INDEX job_items_pending_idx ON job_items (job_id, status, idx);
    `,
  },
  {
    id: 21,
    name: "render keys",
    sql: `
      -- hash(revision + theme integrity + site config) of what a page was last
      -- published with (#67): an unchanged key is not rendered or uploaded again.
      ALTER TABLE site_pages ADD COLUMN render_key text;
    `,
  },
];
