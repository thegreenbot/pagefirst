# Connect an identity provider (SCIM) and lock a domain

Enterprise plan. Owners and admins do this for their organization. Design: [ADR 0005](../docs/adr/0005-enterprise-sso-and-scim.md).

## 1. Create a SCIM token

While signed in as an owner or admin (replace `ORG` with the organization id from `GET /api/orgs`):

```bash
curl -X POST https://<app>/api/orgs/ORG/scim-tokens \
  -H 'content-type: application/json' --cookie "<your session cookie>" \
  -d '{"label": "Okta"}'
```

The response contains the token (`pf_scim_...`) once. Store it in the IdP; it is never shown again. Up to 5 active tokens per organization; revoke with `DELETE /api/orgs/ORG/scim-tokens/<id>`.

## 2. Configure the IdP

- **SCIM base URL:** `https://<app>/api/scim/v2`
- **Authentication:** HTTP header / bearer token, with the token from step 1.
- **Unique identifier for users:** `userName`, which must be the person's Google account email.
- **Supported:** create, update (PUT and PATCH), deactivate, delete; filter `userName eq "..."`; Groups.
- **Roles:** map an attribute to `roles[0].value` (`owner`, `admin`, `editor`, `viewer`), or push groups named after the roles (`pagefirst-admin`, ...). People without a role become `editor`.
- Okta: *Applications → SCIM 2.0 app → Provisioning*, turn on Create, Update and Deactivate users. Entra ID: *Enterprise applications → Provisioning → Automatic*, tenant URL and secret token as above.

People are provisioned **pending** until they first sign in to Pagefirst with that Google account, then join automatically. Deactivated users lose access immediately.

## 3. Lock the organization to your Workspace domain (optional)

Sign in with a Workspace account of that domain, as an owner:

```bash
curl -X PUT https://<app>/api/orgs/ORG/domain -H 'content-type: application/json' \
  --cookie "<your session cookie>" -d '{"domain": "example.com"}'
```

Members whose Google account is not managed by that Workspace lose access until the lock is cleared (`{"domain": null}`). The request is refused if your own account is not in the domain.

## Checks

- `GET /api/scim/v2/Users` with the token returns 200; a revoked token returns 401.
- Provision a test user; `GET /api/orgs` as that user (after signing in) lists the organization.
- Deactivate the test user in the IdP; their next request to the organization fails.
