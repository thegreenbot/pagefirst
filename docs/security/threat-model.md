# Threat model

Pagefirst signs people in with Google, edits their Google Docs through the Docs API, and publishes pages to Cloudflare. This document lists what we protect, who might attack it, where the trust boundaries are, and for each threat the control in place today, the gap, and the issue that closes it.

Last reviewed: 2026-11-27. Review it whenever a route, an OAuth scope, a stored secret or a deployment target changes, and before each release.

## Assets

| Asset | Where it lives today | Why it matters |
| --- | --- | --- |
| Google OAuth grant | With Postgres configured: refresh and access tokens sealed (AES-256-GCM) in `google_tokens`; the browser holds only an opaque session id. Without it: the legacy `pf_access` cookie, 1 hour | Reads and writes the user's Docs. Scopes: identity, `documents`, `drive.file` (`lib/google/oauth.ts`). |
| Doc contents | Google; parsed in memory per request | The user's writing. Also untrusted input to the editor and published HTML. |
| Cloudflare API token | `CLOUDFLARE_API_TOKEN` in the deployment environment | Deploys the public site. |
| Published site | Cloudflare Pages project `page-first` | Public face of every published page. |
| Uploaded media | Process memory (`lib/media.ts`) | User images, served from `/api/media/[id]`. |
| Future API keys and refresh tokens | Not built yet (#16, #36) | Act for a user without a browser. |
| CI and release pipeline | GitHub Actions | Builds what ships. |

## Actors

- **Signed-in author.** Trusted with their own Docs only.
- **Malicious site (CSRF).** Can make the author's browser send requests with the session cookie.
- **Holder of a stolen cookie or API key.** Acts as the user until the credential expires or is revoked.
- **Malicious Doc content.** Anyone with edit access to a Doc, or an automated tool, can put text, links and labels in it that flow into the editor DOM and published HTML.
- **Another signed-in user.** Shares the same app instance and publish target.
- **Compromised dependency.** npm package or GitHub Action running in the app or CI.
- **Compromised CI or maintainer account.** Can change what is built and deployed.

## Trust boundaries

1. **Browser ↔ app.** Cookie-authenticated `/api/*` routes.
2. **App ↔ Google.** OAuth token exchange, Docs and Drive API calls with the user's token.
3. **App ↔ Cloudflare.** Pages deployments with the app's token.
4. **API/MCP client ↔ app.** Not built yet; will use API keys (#36).
5. **Repository ↔ CI ↔ deployment.** Pull requests, Actions and releases.

## Threats, controls and gaps

### Browser ↔ app

| Threat | Current control | Gap | Issue |
| --- | --- | --- | --- |
| Cross-site POST writes to a Doc (CSRF) | `middleware.ts` refuses any non-GET `/api/*` request that is not same-origin (403) and any non-JSON body to commit or publish (415) | None for cookie routes. API-key routes must skip the origin check but keep rate limits | #13 (done), #36 |
| Malformed or oversized commit ops reach Google | Runtime schema for every op, 200-op and 512 KB caps, field-path 400s | Same schema must be reused by API and MCP | #14, #9 |
| Flooding commit, publish or upload | Per-caller rate limits with `Retry-After` | Buckets are per process and evict after 500 keys | #18 |
| Stored XSS from Doc text into the editor or published HTML | `lib/page/render.ts` escapes text, attributes and ids; media served with `nosniff` and a sandbox CSP for SVG | No CSP or security headers on the app; no hostile-content render tests | #19 |
| Uploaded file rendered as a page | MIME allow-list, markup sniffing, `nosniff`, sandbox CSP for SVG | No `Content-Disposition`; media kept in memory | #19, #18 |
| Stolen session cookie | Opaque `__Host-pf_session` id, stored hashed; 7-day idle and 30-day absolute timeouts; sign-out deletes it and revokes the Google grant on the last session; "sign out everywhere" | Legacy `pf_access` mode remains when the database is not configured | #16 (done) |
| Clickjacking the editor | None | No `frame-ancestors` | #19 |

### App ↔ Google

| Threat | Current control | Gap | Issue |
| --- | --- | --- | --- |
| Over-broad grant: the app can read and write every Doc the user can | `drive.file` is requested | The full `documents` scope is also requested | #15 |
| OAuth code interception or login CSRF | `state` and S256 PKCE, both cleared after use; redirect URI fixed by `APP_URL` | None known | — |
| Token leaks into logs or error bodies | Shared `lib/log.ts` redaction (known secrets plus Google token shapes); HTTP tests assert no token in responses, cookies or database rows | — | #16 (done) |
| Acting on a Doc the user may not edit | Every call uses the user's own token; Google's 403 is the answer | None | — |
| No record of who changed which Doc | Append-only `audit_events` in Postgres: sign-in, sign-out, revoke, create, commit, publish, upload and rate-limit denials, with revisions and op kinds but no Doc text, tokens or raw IPs. A trigger refuses UPDATE, DELETE and TRUNCATE; only the retention prune (400 days) may delete. `GET /api/audit` shows an account its own events and lets `AUDIT_ADMIN_EMAILS` export a range | Cross-site refusals happen at the edge, so they are log lines, not rows. The app's database role can still drop the trigger; a separate owner role would close that | #17 |
| Temporary "anyone with the link" Drive share used by `insertInlineImage` stays public if the process dies | Image insert into Docs is not built yet, so no share is created today | When built: remove the permission in `finally`, persist pending shares and sweep them, audit create and remove, or avoid the public share with a short-lived signed URL | #20, #10 |

### App ↔ Cloudflare

| Threat | Current control | Gap | Issue |
| --- | --- | --- | --- |
| One user overwrites or removes another user's published pages | Public publish requires a Google session and an email on `PUBLISH_ALLOWLIST`; each deploy carries the site's other pages forward | All allowed publishers still share one Pages project, and concurrent publishes can race | #85 |
| Cloudflare token misuse | Token only in the deployment environment; error bodies are discarded | Token scope is not documented or enforced | #85 |
| Script in published pages | Text is escaped at render | No CSP for published pages | #19 |
| Published preview lost or served by the wrong instance | — | Previews live in process memory | #18 |

### API/MCP client ↔ app (planned)

| Threat | Current control | Gap | Issue |
| --- | --- | --- | --- |
| Stolen or over-scoped API key | Not built | Needs hashed keys, scopes, revocation, per-key limits and audit | #36, #17 |
| Background jobs act without a fresh grant | `accessTokenFor(sub)` refreshes server-side with single-flight locking | Jobs themselves not built | #16 (done) |

### Repository, CI and deployment

| Threat | Current control | Gap | Issue |
| --- | --- | --- | --- |
| Malicious or vulnerable dependency | `npm audit` gate, Dependency review on PRs, Dependabot, CodeQL | Highs in Next's nested postcss are reported, not blocking, until the Next upgrade | #6 |
| Compromised GitHub Action | Actions pinned to commit SHAs; workflow `permissions: contents: read` by default | — | #6 |
| Secret committed to the repo | gitleaks on every PR and weekly over history; GitHub push protection; [rotation runbook](../../runbooks/secret-rotation.md) | — | #6 |
| Unreviewed change reaches `main` or `develop` | Ruleset: PRs and 9 required checks, no force push or deletion; `v*` tags protected by a tag ruleset | 0 required approvals while there is one maintainer (accepted for now) | #21, #78 |

## Shared prerequisite

Most remaining gaps (#16, #17, #18, #20) need durable shared state. The choice of store is recorded in #10 and blocks them.

## Reporting

See [SECURITY.md](../../SECURITY.md) for how to report a vulnerability.
