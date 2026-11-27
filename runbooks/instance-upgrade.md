# Upgrade a deployed instance

Instances track release branches, not `develop`. Each release is a `vX.Y.Z` tag; schema migrations run once, on the first request after deploy, and are never reversed.

1. **Read the release notes** for the target tag, looking for new environment variables and manual steps.
2. **Back up.** In Neon, create a branch of the database (a point-in-time copy) and note its name. Export the Terraform state.
3. **Move your fork.** Merge the tag into the branch the instance deploys (`git_ref`):
   ```bash
   git fetch upstream --tags
   git checkout main && git merge vX.Y.Z
   ```
   Resolve conflicts, run `npm run ci`, and push through a pull request.
4. **Pin the version.** Set `pagefirst_version` in `instance.auto.tfvars.json` to `vX.Y.Z`, then `terraform plan` and `terraform apply`. Add any new environment variables the release notes name to `infra/instance/main.tf` first.
5. **Redeploy the Worker** if `worker/` or `lib/publish/` changed: `npx wrangler deploy -c "$(terraform output -raw wrangler_config)"`.
6. **Check.** Sign in, open a site, publish a page, and read the deployment log for migration errors.

## Roll back

Redeploy the previous Vercel deployment from the dashboard, set `pagefirst_version` back, and apply. If the release added migrations, the old code may not work with the new schema: restore the Neon branch from step 2 first.
