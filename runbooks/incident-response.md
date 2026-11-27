# Incident response

Use this when a Pagefirst credential may be exposed, or when someone may have acted on users' Google Docs through Pagefirst without permission. Work top to bottom. Write down the time of each step in the private security advisory for the incident.

## 1. Contain

1. **Revoke the Google OAuth client secret.** In Google Cloud Console, open *APIs & Services → Credentials*, open the Pagefirst OAuth client, add a new secret, deploy it as `GOOGLE_CLIENT_SECRET` (see [secret-rotation.md](secret-rotation.md)), then disable and delete the old one. If the client itself is compromised, disable it; every user will have to sign in again.
2. **Revoke user tokens.** Today Pagefirst keeps the Google access token only in the `pf_access` cookie (one hour). Rotating the client secret stops new exchanges. If stored refresh tokens exist (planned under the security epic), delete or revoke every row with Google's revoke endpoint, `https://oauth2.googleapis.com/revoke?token=...`, and rotate the token-encryption key.
3. **Rotate the Cloudflare API token** used for publishing (`CLOUDFLARE_API_TOKEN`), and check the Cloudflare audit log for Pages projects or deployments that Pagefirst did not create.
4. **Stop the bleeding in the app if needed.** Unset `GOOGLE_CLIENT_ID` in the deployment to force sample mode, which disables all Google access until you restore it.

## 2. Find what was affected

1. Check the deployment's request logs for `/api/pages/*/commit`, `/api/pages/*/publish` and `/api/pages` (create) in the window of exposure. Note each `fileId` and signed-in Google account.
2. Use the Google Workspace or Cloud audit logs (*Docs* and *OAuth token* events) for the Pagefirst client ID to list the Docs read or edited.
3. Once Pagefirst has its own audit log, export the entries for the window and match them against the above.
4. For each affected Doc, compare its revision history in Google Docs against the expected edits.

## 3. Recover and tell people

1. Restore affected Docs from revision history where edits were unauthorized.
2. Tell affected users what happened, which Docs were touched, and what they should do (for example, review third-party access at `https://myaccount.google.com/permissions`).
3. Unpublish any Cloudflare page that exposed content it should not have.

## 4. Follow up

1. Publish a GitHub security advisory once fixed, crediting the reporter if they agree.
2. Add a regression test and, if it applies, a CodeQL or gitleaks rule.
3. Review this runbook and fix any step that did not work.
