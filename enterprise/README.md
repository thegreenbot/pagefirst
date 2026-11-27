# Enterprise features

Code in this folder (SCIM provisioning, domain-lock administration) is licensed separately from the rest of Pagefirst, which is Apache-2.0. See [LICENSE.md](LICENSE.md). Everything outside this folder, including the database tables and checks these features rely on (pending memberships, the Workspace domain lock), is Apache-2.0 and can be reused freely.

| Feature | Where |
| --- | --- |
| SCIM 2.0 Users and Groups | `enterprise/scim/`, routes under `app/api/scim/v2/` |
| SCIM tokens and domain-lock admin | `enterprise/scim/tokens.ts`, `app/api/orgs/[orgId]/scim-tokens`, `app/api/orgs/[orgId]/domain` |

Rules for this folder:

- Nothing outside `enterprise/` and the routes listed above imports from it, so a build without the folder is a deletion plus removing those routes.
- Features are gated by plan on the hosted service (`scim`, `domainLock` need the enterprise plan). Self-hosted installs are not gated in code; use of this folder is governed by its license.
- Design: [ADR 0005](../docs/adr/0005-enterprise-sso-and-scim.md).
