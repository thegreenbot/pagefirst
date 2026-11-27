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
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `APP_URL` — optional public origin with no trailing slash. When it is unset, a request whose host ends with `.vercel.app` uses `https://page-first.apps.grok.bot`.

Set them in the server environment. This repository does not include values for them.

Register the Google redirect URI as the site origin plus `/api/auth/callback`. The production URI is `https://page-first.apps.grok.bot/api/auth/callback`. On the local dev server that is `http://127.0.0.1:3847/api/auth/callback`.

## Branches

`develop` is where features merge. Releases are `release/vX.Y.Z` branches merged into `main` and tagged `vX.Y.Z`. Direct pushes to `main` are blocked. Pull requests run lint, unit tests, and a security audit via `npm run ci`. The rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

The [threat model](docs/security/threat-model.md) lists what Pagefirst protects, the controls in place and the open gaps. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Plan

`/plan` still holds the written plan.
