# Contributing

Pagefirst is licensed under the [Apache License 2.0](LICENSE). Before your first pull request is merged, agree to the [Contributor License Agreement](CLA.md) by adding this line to the pull request description:

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

## Secrets

Secrets live only in the deployment environment, never in the repository. That covers `GOOGLE_CLIENT_SECRET`, `CLOUDFLARE_API_TOKEN`, the token-encryption key, and `CURSOR_TOKEN` for `infra/git-flow`, which is only exported in the shell that runs Terraform.

- Do not commit `.env` files. `.gitignore` excludes `.env*`, `*.pem` and Terraform state (`*.tfstate`, `.terraform/`).
- The **Secret scan** workflow runs gitleaks on every pull request and push, and over the full history weekly. GitHub secret scanning with push protection blocks known token formats at push time.
- If a secret reaches a commit, treat it as leaked even if the commit is removed: rotate it with [runbooks/secret-rotation.md](runbooks/secret-rotation.md), then follow [runbooks/incident-response.md](runbooks/incident-response.md).
