# Page-first editor

Edit a page, commit it to a Google Doc, and publish a static snapshot.

## Run

```bash
npm install
npm run dev
```

`npm run dev` starts Next.js on port 3847 at 127.0.0.1. Open [http://127.0.0.1:3847](http://127.0.0.1:3847).

```bash
npm test
```

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

## Plan

`/plan` still holds the written plan.
