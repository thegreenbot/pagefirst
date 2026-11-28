# Contributing

Pagefirst is licensed under the [Apache License 2.0](LICENSE). Before your first pull request is merged, agree to the [Contributor License Agreement](CLA.md). A bot comments on your first pull request; sign by replying with this exact sentence:

> I have read the Pagefirst Contributor License Agreement and agree to it.

# Git flow

`develop` is the integration branch. `main` is the release line. Pull requests are how commits move. `npm install` points this clone at `.githooks`, which refuses pushes that skip the flow.

## Features

Cut `feature/<name>` from `develop`. Cursor agents use `cursor/<name>` the same way. Open the pull request against `develop`. Names are lowercase words separated by `-`, `_`, `.`, or `/`.

## Releases

Cut `release/vX.Y.Z` from `develop`. `X.Y.Z` is semantic versioning (`MAJOR.MINOR.PATCH`), with an optional prerelease such as `release/v1.2.0-rc.1`. Set `package.json` `"version"` to that `X.Y.Z` on the release branch.

Open the pull request against `main`. The **Branch policy** check fails a pull request into `main` from any other branch. After it merges, tag the merge commit on `main`:

```bash
git checkout main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then open a pull request from `main` into `develop` so the release commit is on the integration branch. The tag name matches the branch version: branch `release/v1.2.3`, tag `v1.2.3`.

## Hotfixes

Cut `hotfix/vX.Y.Z` from `main` for a production fix that should not wait for the rest of `develop`. Open it against `main`, tag the merge commit `vX.Y.Z`, then pull `main` back into `develop` the same way as a release.

## CI minutes

GitHub bills Actions per job, rounded up to the minute, so the rules are about fewer jobs and fewer runs:

- Required checks are `ci`, `integration`, `dependency-review`, `gitleaks`, `analyze (javascript-typescript)` and `pr-source`. `ci` runs lint, typecheck, unit tests, coverage, theme byte budgets and `npm audit` in one job with one install. `integration` runs the build, HTTP tests and Playwright. A skipped job reports success, which is how docs-only PRs stay mergeable.
- A docs-only PR (markdown, `docs/`, `runbooks/`) skips `ci` and `integration`. CodeQL skips its steps unless a JS/TS file changed. Dependency review skips its steps unless a manifest, lockfile or workflow changed.
- Lighthouse theme budgets run on a PR only when it touches `themes/`, `lib/theme/`, `lib/page/`, `lib/publish/` or `scripts/theme-budgets`, or carries the `lighthouse` label. Pushes to `develop`, `main`, `release/*` and `hotfix/*` always run them.
- A new push to a PR, or to `develop`, cancels the run in flight. Run `npm run ci` locally and push once instead of pushing small fix-ups.
- CodeQL and gitleaks run on PRs. After merge only `main` is scanned again, plus the weekly schedule. The real-Google contract test runs on develop pushes that touch Google code, weekly, and on demand.
- Draft PRs still run CI. A skipped required check counts as passing, so skipping drafts would let a draft merge once marked ready without ever running tests.
- Dependabot opens at most 3 PRs at a time. Do not merge `develop` into every Dependabot branch at once; each merge re-runs CI.
- A new workflow needs `concurrency` with `cancel-in-progress` on PRs and a `timeout-minutes`. Gate required checks with job-level or step-level `if`, never workflow-level `paths`, or the check never reports and blocks merges.

## Origin rules and PR CI

Direct pushes to `main` and `develop` are refused by the local pre-push hook after `npm install`. On the server, someone with a Cursor API key that can edit Origin rulesets applies either:

```bash
cd infra/git-flow
export CURSOR_TOKEN=...   # Dashboard → Settings → API Keys
terraform init && terraform apply
```

or:

```bash
node scripts/install-origin-git-flow.mjs
```

Terraform also creates the **page-first PR CI** automation, which runs `npm run ci` (lint, unit tests, and `npm audit`) when a pull request opens or gets new commits, posts a comment, and reports a check run. Without Terraform, create that automation at [cursor.com/automations](https://cursor.com/automations) from `automation/pr-ci-prompt.md`.

`.github/workflows/ci.yml` runs the same `npm run ci` command if a CI app such as Depot or Buildkite is connected to the Origin repo.

## Vercel deploys

Vercel Hobby allows 100 deployments a day, so builds are opt-in (`scripts/vercel-ignore.sh`):

- `main` always builds the production site.
- Pushes to `develop`, `feature/*` and any branch without an open PR never build.
- A PR preview builds only when the latest commit message contains `[preview]`, for example `git commit --allow-empty -m "Preview [preview]"` after the PR exists. The tag must be on the newest commit; a later commit without it is skipped.
- CI (`ci`, `integration`) runs on every code PR regardless.
- Merge to `main` as batched `release/vX.Y.Z` PRs, not one merge per feature.

## Secrets

Secrets live only in the deployment environment, never in the repository. That covers `GOOGLE_CLIENT_SECRET`, `CLOUDFLARE_API_TOKEN`, the token-encryption key, and `CURSOR_TOKEN` for `infra/git-flow`, which is only exported in the shell that runs Terraform.

- Do not commit `.env` files. `.gitignore` excludes `.env*`, `*.pem` and Terraform state (`*.tfstate`, `.terraform/`).
- The **Secret scan** workflow runs gitleaks on every pull request and push, and over the full history weekly. GitHub secret scanning with push protection blocks known token formats at push time.
- If a secret reaches a commit, treat it as leaked even if the commit is removed: rotate it with [runbooks/secret-rotation.md](runbooks/secret-rotation.md), then follow [runbooks/incident-response.md](runbooks/incident-response.md).

Your signature is recorded against your GitHub account on the `cla-signatures` branch of this repository, so you sign once. The maintainer and automation accounts (for example Dependabot) are exempt. If the check is stale, comment `recheck`.
