# GitHub rulesets

The branch and tag rulesets for `thegreenbot/pagefirst`, as Terraform. Change them here, through a pull request, rather than in the GitHub settings UI.

| Ruleset | Targets | Rules |
| --- | --- | --- |
| `main and develop` | `main`, `develop` | Pull request required with 0 approvals and resolved conversations; the checks in `variables.tf` must pass; no force pushes; no deletion; no bypass |
| `release tags` | `v*` tags | Only repository admins may create them; nobody may move or delete them |

Required approvals is 0 because the repository has one maintainer, and GitHub never lets an author approve their own pull request. Raise it, and turn on code-owner review, once there is a second maintainer.

## Apply

Use a fine-grained token for this repository with **Administration: read and write**. Keep it in your shell only.

```bash
export GITHUB_TOKEN=...
cd infra/github
terraform init
```

The rulesets already exist, so import them once before the first apply. Their ids are at the end of each ruleset's URL under *Settings → Rules → Rulesets*:

```bash
terraform import github_repository_ruleset.branches pagefirst:27814339
terraform import github_repository_ruleset.release_tags pagefirst:<release tags id>
terraform plan    # should show no changes, or only the drift you expect
terraform apply
```

## Required checks

Each name in `required_checks` is a job name from `.github/workflows/`. A required check that no workflow reports blocks every pull request, so rename a job and this list in the same pull request, and add a new check here only after its workflow is on `develop`.

## Not managed here

The UI's *Require an additional approval for unattributed Copilot pull requests* and *Allowed merge methods* settings may show as drift if your provider version doesn't support them yet. Keep the UI values: Copilot approval on, all merge methods allowed.
