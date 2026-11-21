# Git-flow rules and PR CI automation

Apply this directory with a Cursor user or service-account API key that can edit Origin rulesets and create automations:

```bash
export CURSOR_TOKEN=...   # Dashboard → Settings → API Keys
cd infra/git-flow
terraform init
terraform apply
```

That:

- Blocks direct pushes, force-pushes, and deletion of `main` and `develop`
- Requires pull requests to merge into those branches
- Creates the **page-first PR CI** automation on `william-mccreery/page-first` for pull request opened and pushed events

Without Terraform, create the same automation at [cursor.com/automations](https://cursor.com/automations) using `automation/pr-ci-prompt.md`, and run `node scripts/install-origin-git-flow.mjs` for the rulesets.
