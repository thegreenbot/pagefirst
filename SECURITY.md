# Security policy

Pagefirst signs users in with Google and holds an OAuth grant that can create and edit their Google Docs. We treat any flaw that exposes that grant, or lets someone act on a Doc they should not, as serious.

## Supported versions

Pagefirst is pre-1.0. Only the latest release on `main` (and the deployed production app) receives security fixes.

| Version | Supported |
| --- | --- |
| latest `main` | Yes |
| anything older | No |

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/thegreenbot/pagefirst/security/advisories/new)). Do not open a public issue, pull request or discussion for a suspected vulnerability.

Include what you found, how to reproduce it, and the impact you expect. A proof of concept against your own Google account and Docs is welcome. Please do not access, modify or delete anyone else's data, and do not run automated scans that degrade the service.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix or mitigation for critical and high issues | 30 days |
| Fix for medium and low issues | Next planned release |

We will keep you updated in the advisory thread, credit you in the published advisory if you want, and coordinate disclosure timing with you.

## Scope

In scope:

- Google sign-in: the OAuth flow, state and PKCE handling, session cookies, and the access tokens Pagefirst holds.
- Google Docs access: reading, committing to and creating Docs through the app's API routes.
- Publishing: preview and Cloudflare publish routes and the published pages they produce.
- The API and MCP server, once they ship.
- This repository's CI and release workflows.

Out of scope: vulnerabilities in Google, Cloudflare or GitHub themselves (report those to the vendor), missing best-practice headers with no demonstrated impact, and denial of service through volume.

## If something goes wrong

The maintainer response steps are in [runbooks/incident-response.md](runbooks/incident-response.md). Credential rotation is in [runbooks/secret-rotation.md](runbooks/secret-rotation.md).
