# Set up per-site publishing (R2 + Worker)

Each account publishes to its own folder in one R2 bucket, and one Worker serves every site (#94). This is a one-time setup in Cloudflare and Vercel. Never paste the token anywhere but the Vercel environment settings.

1. **Domain.** Add the publish domain to Cloudflare (Websites → Add a site) if it isn't there already.
2. **Bucket.** R2 → Create bucket → name it `pagefirst-sites`.
3. **Token for the app.** R2 → Manage API tokens → Create API token → permission *Object Read & Write*, applied to `pagefirst-sites` only. Copy the token value.
4. **Worker.** From `worker/` in this repo, set the route in `wrangler.toml` to `*.<your domain>/*` with your zone, then run `npx wrangler deploy`. The Worker reads the bucket through its `SITES` binding and needs no token.
5. **DNS.** Add a proxied wildcard record `*` (for example an `AAAA` to `100::`) so every site subdomain reaches the Worker.
6. **Vercel env vars** (Production): `R2_BUCKET=pagefirst-sites`, `R2_API_TOKEN=<token from step 3>`, `CLOUDFLARE_ACCOUNT_ID=<account id>`, `PUBLISH_DOMAIN=<your domain>`. Redeploy.
7. **Check.** Publish a page with "public" on. The response URL should be `https://p……….<your domain>/<path>` and load with a `Content-Security-Policy` header.

Once this works, the shared Pages project, `CLOUDFLARE_API_TOKEN` and `PUBLISH_ALLOWLIST` can be removed.
