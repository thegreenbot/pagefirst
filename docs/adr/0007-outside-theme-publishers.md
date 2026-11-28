# 0007: Outside theme publishers are invite-only and reviewed by hand

Status: accepted (2026-11-28, #68)

## Context

The registry lists first-party `@pagefirst/*` themes. Letting anyone publish
code that runs on other people's published sites invites abuse, and automated
checks alone can't tell a benign theme from a hostile one.

## Decision

- No self-serve community tier. A **system administrator** (a Google account id
  in `PAGEFIRST_SYSTEM_ADMINS`; nothing in the database can grant it) invites a
  publisher: a scope `@slug/` bound to one GitHub repository. `@pagefirst` and
  `@org-*` are reserved.
- The invited repository's `theme-publish.yml` workflow submits a version with
  a GitHub OIDC token and Sigstore attestation, on the tag `theme-<dir>-v<version>`,
  exactly as first-party publishing does. The repository is looked up from the
  name's scope, so a publisher can never submit outside their scope.
- A submission is built in a **sandbox**: the archive is unpacked and loaded as
  data, run through the static submission checks (`lib/theme/checks.ts`) and
  rendered against the byte budgets. A theme's own code never runs on the
  server. Failing submissions get a 422 and nothing is stored; passing ones are
  stored `pending` (202) and are not listed.
- A system administrator approves or rejects (with a reason) in
  `/api/admin/theme-submissions`. Approval publishes the version as `verified`
  with the reviewer in its provenance. Invites, revocations, submissions and
  decisions are audited.
- Revoking a publisher stops new submissions. Versions already approved stay
  listed until yanked.

## Consequences

- Not yet built: Lighthouse, axe and screenshots in the sandbox (the reviewer
  reads the report and the diff for now), and an admin UI (the API is enough
  for the first few publishers).
- The `community` tier and `acceptUnreviewed` install confirmation from the
  first slice stay in the code but nothing produces a community version.
