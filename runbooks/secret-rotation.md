# Secret rotation

Pagefirst's secrets live only in the deployment environment (and, for Terraform, in the operator's shell). They are never committed. Rotate a secret right away if it may have leaked, and otherwise at least once a year.

| Secret | Where it is used | Where it lives |
| --- | --- | --- |
| `GOOGLE_CLIENT_SECRET` | OAuth code exchange | Deployment environment |
| `CLOUDFLARE_API_TOKEN` | Publishing to Cloudflare | Deployment environment |
| Token-encryption key (planned) | Encrypting stored refresh tokens | Deployment environment |
| `CURSOR_TOKEN` | `infra/git-flow` Terraform | Operator's shell only |

## `GOOGLE_CLIENT_SECRET`

1. Google Cloud Console → *APIs & Services → Credentials* → the Pagefirst OAuth client → **Add secret**.
2. Set the new value as `GOOGLE_CLIENT_SECRET` in the deployment environment and redeploy.
3. Sign in on the deployed app to confirm the exchange works.
4. Back in the console, disable the old secret, wait an hour for in-flight exchanges, then delete it.

## `CLOUDFLARE_API_TOKEN`

1. Cloudflare dashboard → *My Profile → API Tokens* → **Create token** with the same permissions as the current one (Pages edit on the publishing account only).
2. Set it as `CLOUDFLARE_API_TOKEN` in the deployment environment and redeploy.
3. Publish a test page to confirm.
4. Roll or delete the old token.

## Token-encryption key (when stored tokens ship)

1. Generate a new 32-byte random key.
2. Deploy it alongside the old key so the app can decrypt with either and encrypts with the new one.
3. Re-encrypt every stored token with the new key.
4. Remove the old key from the environment and redeploy.

## `CURSOR_TOKEN`

1. Cursor dashboard → *Settings → API Keys* → create a new key, then delete the old one.
2. It is only exported in the shell that runs `terraform apply`; nothing else to update.
