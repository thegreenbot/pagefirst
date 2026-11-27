# ADR 0004: Organizations, roles and plans

- Status: accepted
- Date: 2026-11-27
- Issues: #43 (epic), #45, #65

## Context

The hosted service needs a tenant boundary, and paid features (custom CSS and template overrides, #65) need a plan to check. Billing (#47) is not built yet.

## Decision

- Every site belongs to one **organization**. A user's first site creates their **personal organization** (`org_` + md5 of the Google `sub`), so single users need no setup. Existing sites were moved into personal organizations by migration 13.
- **Roles**: `owner`, `admin`, `editor`, `viewer`, in that order. An organization always keeps one owner. Seats for billing are editors and above; viewers are free.
- **Plan** lives on the organization: `free`, `pro`, `team`, `enterprise`. Only billing (#47) or an operator changes it, never a customer-facing route.
- **Features**: brand tokens are on every plan. `customCss` and `templateOverrides` need a paid plan.
- **Editions**: gating applies only when `PAGEFIRST_EDITION=hosted`. Self-hosted installs, the default, are never gated.
- `requireFeature(siteId, feature)` throws `PlanError` (HTTP 402) and is what #65 calls before saving custom CSS or an override.
- Cancelling deletes the organization, its sites and their data, and revokes API keys and deletes the Google grant of members who belong to no other organization.

## Not yet

Existing routes still resolve a site through its owner (`siteForOwner`). Moving each route to `canAccessSite(sub, siteId, role)`, inviting members and an organization switcher come with multi-site support.
