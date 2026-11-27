# ADR 0003: Machine authentication for the API and MCP

- Status: accepted
- Date: 2026-11-27
- Decided by: Will (issue #36)

## Context

Every Docs read and write must run as a Google identity that can see that Doc. PLAN.md: a 403 from Google is the answer, and the app keeps no ACL of its own. Scripts and agents cannot click through a browser OAuth flow per call, and `lib/service` (#11) now takes an explicit context instead of reading cookies.

## Decision

**Scoped Pagefirst credentials tied to the creating user's stored Google grant. No Workspace service account.**

- A user signs in once. Pagefirst keeps their Google refresh token server-side (#16) and refreshes access tokens itself.
- **API keys** (`pf_live_` + 43 random characters) are created by a signed-in user with a name, scopes, an optional list of Drive site folders, and an expiry (default 90 days, at most 365). Calls run as that user.
- **MCP clients** get short-lived Pagefirst OAuth 2.1 tokens with the same scopes. Pagefirst is the authorization server. Google tokens never leave the server.
- Out of scope: a Google Workspace service account with domain-wide delegation. Revisit only on explicit request.

### OAuth 2.1 for MCP

- Metadata at `/.well-known/oauth-authorization-server` (RFC 8414) and `/.well-known/oauth-protected-resource` (RFC 9728).
- Dynamic client registration (RFC 7591) at `/api/oauth/register`, public clients only (no client secret), 1 to 5 redirect URIs that are `https` or loopback `http`, matched exactly. Rate limited per caller.
- `/oauth/authorize`: authorization code with PKCE `S256` only. The user signs in with Google, then sees a consent screen naming the client and its scopes. A bad client or redirect URI is shown as an error page and never redirected to. Default scope is read-only. The consent POST is same-origin only, and it answers with a 200 page that refreshes to the client, because Chrome applies `form-action` to redirects.
- `/api/oauth/token`: `authorization_code` and `refresh_token` grants. Codes live 10 minutes and work once; replaying a code revokes the tokens it issued. Access tokens (`pf_at_`) live 1 hour. Refresh tokens (`pf_rt_`) live 30 days and rotate on each use; presenting a spent one revokes the whole family. Scopes can never widen on refresh.
- `/api/oauth/revoke` (RFC 7009).
- All token, code and refresh secrets are stored as SHA-256 only. Access tokens act through the same bearer path as API keys, with `client: "mcp"` in the audit log.
- Not yet: the `resource` indicator (RFC 8707) is accepted but not bound to tokens, and there is no per-client management page. Both can follow with the MCP server (#41).

### Scopes

| Scope | Allows |
| --- | --- |
| `pages:read` | List and read pages, render a preview |
| `pages:commit` | Create pages and commit ops |
| `pages:import` | Import changes made directly in a Doc |
| `pages:publish` | Publish a public copy |

Publish is never implied by commit, and nothing implies anything else. A browser session holds every scope.

Scope checks live in `lib/service`, at the top of each function, so no adapter (REST, MCP, jobs) can skip them.

### Site folders

An optional allow-list of Drive folder ids. It matches Docs directly inside a listed folder, not nested ones. A page outside the list answers `not_found`, the same as a missing page, so a key cannot probe what exists elsewhere. Creating a page is refused for a restricted key, because a new Doc lands in the Drive root. If the service has no way to look up a file's folder, a restricted key is refused rather than allowed.

### Storage and verification

- Only `SHA-256(key)` is stored, in `api_keys`, with a short display prefix. The key is shown once, at creation, with `Cache-Control: no-store`.
- Every request looks the key up in Postgres. Nothing is cached, so **revoking takes effect on the next request**.
- Keys are 256 random bits, so a fast hash is enough. The `pf_live_` prefix lets GitHub secret scanning and gitleaks match a leaked key.
- `last_used_at` is updated at most once a minute per key.
- A key stops working when its owner disconnects Google or signs out everywhere, because there is no grant left to act with.
- A user may hold at most 25 active keys.

### Transport

Bearer credentials go in `Authorization: Bearer ...`. `/api/v1/*` never reads cookies, so it has no CSRF surface and skips the origin check in middleware (not the content-type check or the rate limit). Key management (`/api/keys`) is cookie-authenticated and same-origin only: a key cannot create or revoke keys.

## Consequences

- A leaked key can do what its scopes, folders and expiry allow until revoked. The audit log records `api_key.created` and `api_key.revoked`; `api_key.used` per request arrives with the REST API (#37).
- Actions by a key run as the user in Google's own audit trail, so Google attributes edits to a person, not to Pagefirst.
- The user must keep their Google grant alive. Reconnecting Google revives their keys.
