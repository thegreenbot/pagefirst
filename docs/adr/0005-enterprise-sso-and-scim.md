# ADR 0005: Enterprise sign-in control and SCIM

- Status: accepted (decided by the project owner)
- Date: 2026-11-27
- Issues: #43 (epic), #49

## Context

Enterprise buyers ask for single sign-on and automatic user provisioning. Pagefirst's only sign-in is Google, and every user must grant Google access anyway, because Docs and Drive are the product. A second login path for another identity provider (SAML or OIDC) would still require each person to connect Google afterwards, and it would add a large security surface (XML signatures, assertion replay, account linking) for no reduction in what a customer must trust.

## Decision

- **Sign-in stays Google.** Customers on Okta, Entra ID or similar federate their IdP into Google Workspace; Pagefirst sees an ordinary Google sign-in. No SAML or OIDC login code is added.
- **Domain lock.** An organization can require its members to sign in from a Google Workspace domain. The domain comes from the `hd` claim, which only Workspace-managed accounts carry; a personal Google account that merely uses an `@company.com` email does not pass. The check is in `roleOf`, `canAccessSite` and `listMemberships`, so every path that resolves a role is covered. An owner can set it only while signed in from that domain.
- **SCIM 2.0** (`/api/scim/v2`): Users and Groups, authenticated by per-organization bearer tokens. `userName` is the person's email. A person who has not signed in yet gets a **pending membership** that is claimed at sign-in by a matching verified email (and passes the domain lock). Deactivating or deleting removes access. Groups are the four roles: membership of a group named `owner`, `admin`, `editor` or `viewer` (optionally prefixed `pagefirst-`) sets that role, and leaving it demotes to `viewer`, which is not a billed seat. The last owner can never be removed or demoted by the IdP.
- **Audit log for admins.** Admin actions (`org.scim_token.*`, `org.domain_lock`, `scim.provision`) are audited. Showing an organization's audit events to its admins needs the audit table to carry an organization id and is tracked separately in #49.
- **Licensing.** The SCIM and admin code lives in `enterprise/` under a separate license (see `enterprise/README.md`). The tables and checks they depend on (pending memberships, the domain lock) stay in the Apache-2.0 core, so the core never imports enterprise code. On the hosted service the `scim` and `domainLock` features need the enterprise plan; self-hosted installs are not gated in code.

## Consequences

- Hosted customers who are not on Google Workspace cannot use SSO. Each such request will be weighed against the cost of a second login path.
- The domain lock fails closed: if Google ever stops sending `hd` in the userinfo response, locked organizations would deny everyone. `lib/google/userinfo.ts` has a test for the field; verify with a real Workspace account before promising the feature.
- Legacy routes that resolve a site through its owner (`siteForOwner`) are not affected by the lock, since an owner already has the role.
- SCIM Groups are fixed to the four roles. Arbitrary IdP groups are not created.
