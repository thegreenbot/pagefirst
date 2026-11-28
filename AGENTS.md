# Agent notes

- Work on `feature/*` branches, one small PR per issue into `develop`. See CONTRIBUTING.md for git flow.
- Run `npx tsc --noEmit`, `npx eslint lib app` and `npm test` before pushing.

## Vercel previews are off by default

Vercel Hobby allows 100 deployments a day, so builds are opt-in (`scripts/vercel-ignore.sh`):

- `main` always builds the production site.
- Pushes to `develop`, `feature/*` and any branch without an open PR never build.
- A PR preview builds only when the latest commit message contains `[preview]`, for example `git commit --allow-empty -m "Preview [preview]"` after the PR exists. The tag must be on the newest commit; a later commit without it is skipped.
- CI (lint, typecheck, test, build, integration) runs on every PR regardless.
- Merge to `main` as batched `release/vX.Y.Z` PRs, not one merge per feature.

To see a PR preview, open the PR and push a commit whose message contains `[preview]`. Do not do this on every push.
