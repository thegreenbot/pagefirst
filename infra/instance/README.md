# Deploy a Pagefirst instance

One config file stands up a complete instance: the app on Vercel, a Neon Postgres database, an R2 bucket and Worker that serve published sites, DNS for the sites, and a per-instance encryption key. Use it to self-host, or to run an isolated instance for a customer who can't share a database.

| Piece | Resource |
| --- | --- |
| App | Vercel project and domain, with all environment variables set |
| Database | Neon project (`DATABASE_URL`) |
| Publish target | R2 bucket, a wildcard DNS record and a Worker (`worker/`) |
| Encryption key | Random 32 bytes (`TOKEN_ENCRYPTION_KEY`), one per instance |

Shared rate limits use Postgres when `KV_REST_API_*` (Upstash) is not set, so no extra service is required. Add the Upstash integration in Vercel later if you want it.

## Before you start

You need accounts and tokens for each provider. Tokens stay in your shell; none goes in the config file.

1. **Cloudflare**: the publish domain as a zone (note its zone id and your account id), an API token that can edit R2, DNS and Workers (`CLOUDFLARE_API_TOKEN`), and a second token limited to *Object Read & Write* on the instance's bucket (`R2_API_TOKEN`; create the bucket with the first apply, then the token, then apply again, as in [runbooks/site-publishing.md](../../runbooks/site-publishing.md) step 3).
2. **Vercel**: an API token (`VERCEL_API_TOKEN`) and your fork of Pagefirst with the Vercel GitHub app installed.
3. **Neon**: an API key (`NEON_API_KEY`).
4. **Google**: an OAuth client. For a dedicated instance, create it in the customer's own Google Cloud project with the `documents` and `drive.file` scopes. If the project belongs to their Workspace and the app is set to *Internal*, Google needs no verification and the customer gets their own Docs API quota. Otherwise the app needs Google verification: see [docs/google-verification.md](../../docs/google-verification.md).

## Deploy

```bash
cd infra/instance
cp instance.example.json instance.auto.tfvars.json   # edit every value
node ../../scripts/instance-check.mjs                # catches mistakes early

export CLOUDFLARE_API_TOKEN=... VERCEL_API_TOKEN=... NEON_API_KEY=...
export TF_VAR_google_client_secret=... TF_VAR_r2_api_token=...

terraform init
terraform plan
terraform apply
```

Then finish three things Terraform can't:

1. Register the `google_redirect_uri` output as an authorized redirect URI on the Google OAuth client.
2. Create the DNS record in the `app_dns` output for the app hostname, DNS-only (not proxied), at wherever that domain's DNS lives.
3. Deploy the Worker: `npx wrangler deploy -c "$(terraform output -raw wrangler_config)"`.

Trigger a Vercel production deploy (push to `git_ref`, or redeploy in the dashboard), sign in, and publish a page. The URL should be `https://p….<publish_domain>/…`.

## Config reference

See `variables.tf` for every setting and its rules. The required ones are `name`, `app_domain`, `publish_domain`, `cloudflare_account_id`, `cloudflare_zone_id`, `git_repository`, `pagefirst_version` and `google_client_id`.

- `app_domain` and `publish_domain` must differ. The app hostname must stay DNS-only so it never passes through the Worker.
- `git_ref` is the branch Vercel deploys to production. Pin it to a release branch such as `main`, never `develop`.
- `pagefirst_version` records the release you run. It does not check out code by itself; see below.

## State and the encryption key

Terraform state holds the database URL and the instance's encryption key. Keep it private: use an encrypted remote backend with access limited to the operators of this instance, and never commit it (`.gitignore` already excludes state files and `instance.auto.tfvars.json`). Losing the key makes stored Google refresh tokens unreadable; users then sign in again. To rotate it, follow [runbooks/secret-rotation.md](../../runbooks/secret-rotation.md).

## Upgrades

See [runbooks/instance-upgrade.md](../../runbooks/instance-upgrade.md).
