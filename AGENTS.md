# Agent notes

- Work on `feature/*` branches, one small PR per issue into `develop`. See CONTRIBUTING.md for git flow.
- Run `npx tsc --noEmit`, `npx eslint lib app` and `npm test` before pushing.

## Vercel previews are off by default

Vercel Hobby allows 100 deployments a day, so builds are opt-in (`scripts/vercel-ignore.sh`):

- `main` always builds the production site.
- Pushes to `develop`, `feature/*` and any branch without an open PR never build.
- A PR preview builds only when the latest commit message contains `[preview]`, for example `git commit --allow-empty -m "Preview [preview]"` after the PR exists. The tag must be on the newest commit; a later commit without it is skipped.
- CI (`ci`, `integration`) runs on every code PR regardless.
- Merge to `main` as batched `release/vX.Y.Z` PRs, not one merge per feature.

To see a PR preview, open the PR and push a commit whose message contains `[preview]`. Do not do this on every push.

## CI minutes

Actions bill per job, rounded up to the minute. The full rules are under "CI minutes" in CONTRIBUTING.md. For agents:

- Run `npm run ci` locally, then push once. Every push to a PR starts a new run and cancels the previous one.
- Required checks: `ci`, `integration`, `dependency-review`, `gitleaks`, `analyze (javascript-typescript)`, `pr-source`. Add a step to `ci` rather than a new per-tool job.
- Lighthouse runs on a PR only if it touches themes or rendering code, or has the `lighthouse` label.
- Docs-only PRs skip the heavy jobs by design. Drafts still run CI.
- Changing a required check name needs a ruleset update on main and develop. Gate with job-level or step-level `if`, never workflow-level `paths`.
