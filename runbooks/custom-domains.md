# Custom domains

Owners serve a published site from their own domain (#181). The hosted service uses Cloudflare for SaaS custom hostnames on the publish zone; a self-hosted instance can use the manual provider.

## One-time setup (Cloudflare for SaaS)

1. In the Cloudflare zone that holds the publish domain, enable **SSL/TLS → Custom Hostnames** (Cloudflare for SaaS). Check the current included hostnames and per-hostname price on the plan page first.
2. Set the **fallback origin** to a proxied DNS record that routes to the site Worker, e.g. `fallback.<publish domain>`, and give owners a stable CNAME target, e.g. `domains.<publish domain>` (a proxied CNAME to the fallback origin).
3. Attach the site Worker to a route that covers custom hostnames (`*/*` on the zone, with the Worker ignoring hosts it has no `hosts/<hostname>` record for).
4. Create an API token with **SSL and Certificates: Edit** on that zone only.
5. Set, in the app environment:

| Variable | Value |
| --- | --- |
| `DOMAIN_PROVIDER` | `cloudflare-saas` |
| `CLOUDFLARE_SAAS_ZONE_ID` | the zone id |
| `CLOUDFLARE_SAAS_API_TOKEN` | the token from step 4 |
| `CUSTOM_DOMAIN_CNAME_TARGET` | the CNAME target from step 2 |

## What an owner does

Add a CNAME from their hostname to the target. Cloudflare validates the hostname over HTTP once the CNAME resolves, issues the certificate and renews it. If they add a TXT ownership or certificate record from the editor, that validates before the CNAME is live. Bare (apex) domains aren't supported at launch (#191); they use `www` or a subdomain.

## Self-hosted (manual provider)

Set `DOMAIN_PROVIDER=manual` and `CUSTOM_DOMAIN_CNAME_TARGET` to your front door. Owners add a CNAME to it and a TXT record at `_pagefirst-challenge.<hostname>` with the value shown in the editor. The app checks both in DNS. Terminating TLS for those hostnames is your proxy's job (for example on-demand TLS gated on the app's domain list).

## Ownership and takeover

A hostname is routed only after the provider reports it active, and `hosts/<hostname>` is written by the domain service (#186) alone. A second site can't claim a hostname another site holds.

## Rotating the token

Create a new token, update `CLOUDFLARE_SAAS_API_TOKEN`, redeploy, then delete the old one. See `secret-rotation.md`.

## Takedown (abuse reports)

To stop a hostname that is being abused (phishing, malware, impersonation):

1. Call `POST /api/admin/domains/disable` as a system administrator (`PAGEFIRST_SYSTEM_ADMINS`) with `{"hostname": "bad.example.com", "reason": "…"}`. Blocking `example.com` also covers everything under it.
2. Serving stops at once: the `hosts/<hostname>` record is deleted, which is all the Worker looks at. The provider hostname is released, and the owner sees "This domain can't be used."
3. The name is recorded in `blocked_domains`, so it can't be added again and a provider that still reports it active can't bring it back. To undo a mistaken block, delete the row.

The daily jobs tick also sweeps orphans: `hosts/` records and provider hostnames that no domain row holds are removed, and its response reports how many (`swept`). Deleting a site or closing an organization removes its domains first. A domain can be moved between one owner's sites (`POST /api/site/domains/<id>/transfer`); it stays held the whole time, so no one else can claim it, and serves again once the provider confirms it for the new site.
