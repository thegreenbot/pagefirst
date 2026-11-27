# Page-first editor

Edit a page, commit it to a Google Doc, and publish a static snapshot.

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts Next.js on port 3847 at 127.0.0.1. Open [http://127.0.0.1:3847](http://127.0.0.1:3847).

```bash
npm test               # unit tests
npm run test:coverage  # unit tests with the coverage floor for lib/google and lib/guard
npm run build
npm run test:http      # route handlers over HTTP against the build, with a fake Google
npm run test:e2e       # Playwright smoke test of the editor in sample mode
npm run test:contract  # real Google Docs/Drive contract test (skips without TEST_GOOGLE_* env)
```

`test:http` and `test:e2e` need `npm run build` first. `test:e2e` needs a Chromium from `npx playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH` to one already installed.

`test:contract` talks to real Google. It creates a throwaway Doc, adopts and commits edits through `lib/google`, checks the result, and deletes the Doc. It needs `TEST_GOOGLE_CLIENT_ID`, `TEST_GOOGLE_CLIENT_SECRET` and `TEST_GOOGLE_REFRESH_TOKEN` for an OAuth client in the separate `pagefirst-contract` Google Cloud project, with the scopes `documents` and `drive.file`. CI runs it weekly and on demand from the **Google contract** workflow, using secrets in the `google-contract` environment.

## Sample mode

Sample mode works with no credentials. The home page lists sample pages until Google is connected.

## Environment

The server reads these variables:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CLOUDFLARE_ACCOUNT_ID`
- `R2_BUCKET`, `R2_API_TOKEN` — the sites bucket and a token that can only read and write that bucket.
- `PUBLISH_DOMAIN` — the domain sites are published under, e.g. `example.com` gives each site `p1a2b3c4d5.example.com`. With R2 and `DATABASE_URL`, each account publishes to its own site. See [runbooks/site-publishing.md](runbooks/site-publishing.md).
- `THEME_REGISTRY_PUBLIC_KEYS` — the theme registry's Ed25519 public keys (comma-separated, for rotation). Publishes render a registry theme version only when one of these keys countersigned it. `THEME_REGISTRY_SIGNING_KEY` — the matching private key, only where versions are published. See [runbooks/theme-registry.md](runbooks/theme-registry.md).
- `CLOUDFLARE_BROWSER_TOKEN` — optional. An API token with only "Browser Rendering - Edit", used with `CLOUDFLARE_ACCOUNT_ID` to screenshot theme change previews and diff them pixel by pixel. Without it, previews compare markup only.
- `CLOUDFLARE_API_TOKEN` — only for the old shared Pages project, used while R2 is not configured.
- `DATABASE_URL` — optional Neon Postgres connection string (set by the Vercel Neon integration). Without it the app runs without sessions in the database, audit or shared state. See [ADR 0001](docs/adr/0001-persistent-store.md).
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` — optional Upstash Redis for shared rate limits (set by the Vercel Upstash integration). Without them, limits are shared through Postgres when `DATABASE_URL` is set, otherwise kept per process.
- `TOKEN_ENCRYPTION_KEY` — 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored Google refresh tokens.
- `PUBLISH_ALLOWLIST` — only used while R2 is not configured: Google emails (comma- or space-separated) allowed to publish to the shared Pages project. Unset means nobody can; previews still work (#85 stopgap).
- `AUDIT_ADMIN_EMAILS` — optional Google emails (comma- or space-separated) that may export every account's audit events from `GET /api/audit?from=…&to=…`. Everyone signed in can read their own events.
- `APP_URL` — the public origin with no trailing slash, such as your Vercel production domain. Set it in production: sign-in redirects and the secure session cookie use it. When it is unset, the app uses the request's own origin (https for `*.vercel.app`).

Set them in the server environment. This repository does not include values for them.

Register the Google redirect URI as the site origin plus `/api/auth/callback`. In production that is `APP_URL` plus `/api/auth/callback`. On the local dev server that is `http://127.0.0.1:3847/api/auth/callback`.

## Branches

`develop` is where features merge. Releases are `release/vX.Y.Z` branches merged into `main` and tagged `vX.Y.Z`. Direct pushes to `main` are blocked. Pull requests run lint, unit tests, and a security audit via `npm run ci`. The rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

The [threat model](docs/security/threat-model.md) lists what Pagefirst protects, the controls in place and the open gaps. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Plan

`/plan` still holds the written plan.
