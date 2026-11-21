# Git flow

`develop` is the integration branch. `main` is the release line. Pull requests are how commits move. `npm install` points this clone at `.githooks`, which refuses pushes that skip the flow.

## Features

Cut `feature/<name>` from `develop`. Cursor agents use `cursor/<name>` the same way. Open the pull request against `develop`. Names are lowercase words separated by `-`, `_`, `.`, or `/`.

## Releases

Cut `release/vX.Y.Z` from `develop`. `X.Y.Z` is semantic versioning (`MAJOR.MINOR.PATCH`), with an optional prerelease such as `release/v1.2.0-rc.1`. Set `package.json` `"version"` to that `X.Y.Z` on the release branch.

Open the pull request against `main`. After it merges, tag the merge commit on `main`:

```bash
git checkout main
git pull
git tag vX.Y.Z
git push origin vX.Y.Z
```

Then open a pull request from `main` into `develop` so the release commit is on the integration branch. The tag name matches the branch version: branch `release/v1.2.3`, tag `v1.2.3`.

## Hotfixes

Cut `hotfix/vX.Y.Z` from `main` for a production fix that should not wait for the rest of `develop`. Open it against `main`, tag the merge commit `vX.Y.Z`, then pull `main` back into `develop` the same way as a release.

## Origin rules

Someone who can edit repository rules runs this once from a checkout:

```bash
node scripts/install-origin-git-flow.mjs
```

That applies the same names on the server, refuses direct pushes to `main` and `develop`, keeps tags immutable, and sets the default branch to `develop`.
