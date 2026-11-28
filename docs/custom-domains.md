# Custom domains

Publish your site at your own address, such as `www.example.com`, instead of `yoursite.pagefirst.io`. Custom domains are included on every paid plan.

## Add a domain

1. In the editor, open **Custom domain** and enter a subdomain, for example `www.example.com` or `docs.example.com`. Bare domains (`example.com`) aren't supported yet; use `www` and have your registrar forward the bare domain to it.
2. The editor shows the DNS record to create. Add it at the place that hosts your DNS (usually your registrar):
   - **Type** `CNAME`, **name** the subdomain (`www`), **value** the target shown in the editor.
   - Some domains also show a `TXT` record for ownership or the certificate. Add those too.
3. Select **Check now**. DNS changes usually take a few minutes and can take up to a few hours. The status moves from *Waiting for DNS* to *Verifying* to *Live*. We also re-check every day.
4. Once it is live, your pagefirst.io address redirects to the new one, keeping the page path.

### Where to add the record

| Where your DNS is | Where to look |
| --- | --- |
| Cloudflare | DNS, Records, Add record. Turn the proxy off (grey cloud) for this record. |
| GoDaddy | My Products, DNS, Add New Record. |
| Namecheap | Domain List, Manage, Advanced DNS, Add New Record. |
| Google Domains / Squarespace Domains | DNS, Custom records. |
| Route 53 | Hosted zones, your zone, Create record. |

Enter the name relative to your domain (`www`), not the full name, unless the page says otherwise.

## What the messages mean

| Message | What to do |
| --- | --- |
| Waiting for DNS | The record isn't visible yet. Check it for typos and wait a few minutes. |
| Verifying | The record is right and the certificate is being issued. No action needed. |
| This domain can't be used | The name is reserved or has been disabled. Contact support if you think this is a mistake. |
| Your plan doesn't include custom domains | Upgrade to a paid plan. |
| Domain limit reached | Remove a domain you don't need, or upgrade. |
| Needs attention | Read the line under the domain; usually the DNS record changed or was removed. Fix it and select **Check now**. |

## If your plan changes

If you move to a plan without custom domains, your domain keeps working for 14 days, then stops serving. Your DNS records and your site are never deleted, and upgrading again brings it back.

## Moving or removing a domain

**Remove** stops serving the domain right away and frees it. Your DNS records stay where they are; delete them at your DNS host when you no longer need them. To move a domain to another of your sites, use the API (`POST /api/site/domains/<id>/transfer`): it stays reserved for you while it is re-verified for the new site.

## API and MCP

`GET/POST /api/v1/site/domains`, `POST /api/v1/site/domains/{id}/check` and `DELETE /api/v1/site/domains/{id}` use your API key (`pages:read` to list, `pages:publish` to change). The MCP tools are `list_site_domains`, `add_site_domain`, `check_site_domain` and `remove_site_domain`; see [mcp.md](mcp.md).

## Self-hosting

On your own install, either:

- **Cloudflare for SaaS:** enable it on the zone that serves your published sites and set `DOMAIN_PROVIDER=cloudflare-saas`, `CLOUDFLARE_SAAS_ZONE_ID`, `CLOUDFLARE_SAAS_API_TOKEN` and `CUSTOM_DOMAIN_CNAME_TARGET`. Steps are in [runbooks/custom-domains.md](../runbooks/custom-domains.md).
- **Manual provider:** set `DOMAIN_PROVIDER=manual` and `CUSTOM_DOMAIN_CNAME_TARGET`. Owners add a CNAME and a TXT record at `_pagefirst-challenge.<hostname>`, and the app checks both in DNS. Your own proxy terminates TLS.

Self-hosted installs have no plan gating: every site may add domains, up to the limits (5 per site, 25 per account by default).
