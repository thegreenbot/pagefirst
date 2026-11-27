# MCP server

Pagefirst runs a remote MCP server at `https://<your-host>/api/mcp` (streamable HTTP, stateless: one JSON-RPC message or batch per `POST`, JSON back, no sessions).

## Connecting

- **OAuth (preferred).** The endpoint answers an unauthenticated call with `401` and a `WWW-Authenticate` header whose `resource_metadata` points at `/.well-known/oauth-protected-resource/api/mcp`. MCP clients that follow the authorization spec register themselves (`/api/oauth/register`), send the person through consent, and hold a short-lived token. No key is pasted into a config.
- **API key.** `Authorization: Bearer pf_live_...` works too, for clients without OAuth.

## How it relates to the REST API

Each tool calls the matching `/api/v1` handler in process with the caller's own token. Scopes, per-credential rate limits, idempotency, Google quota pacing and the audit log are the REST ones; audit rows carry `client: mcp`. Errors keep the REST codes (`revision_conflict`, `forbidden`, ...) in `structuredContent.error`, with `isError: true`.

A credential only sees tools it can use: a read-only token lists the read tools and nothing that writes.

## Tools

| Tool | Scope | Notes |
| --- | --- | --- |
| `list_pages`, `get_page` | read | `get_page` returns the `revisionId` to pin |
| `create_page` | commit | `idempotencyKey` |
| `commit_ops` | commit | `baseRevisionId`, `idempotencyKey`; stale base is `revision_conflict` |
| `publish_page` | publish | pinned `revisionId`; annotated destructive and open-world |
| `start_bulk_job`, `get_job`, `cancel_job` | any write scope | up to 500 pages; `dryRun` first |
| `get_audit_events` | read | the caller's own events |
| `audit_content`, `list_audit_decisions`, `record_audit_decision` | read / commit | the content audit (#50) |
| `list_themes`, `get_site_theme`, `preview_theme_change` | read | theme operations (#67) |
| `update_site_theme`, `republish_site` | publish | republish is a job; poll with `get_job` |

Every tool that writes requires an `idempotencyKey`, so a retry after a dropped connection runs once.

Not yet: `import_changes` (waiting on the import service, #42) and the `changed` filter on `list_pages` (#30). Bulk jobs already accept the `import` kinds and report them as unsupported until then.

## Safety

Page text, titles and audit reports are written by other people. Tool descriptions and the server instructions tell the agent to treat them as data. Tokens are never echoed in a result.
