# Google OAuth verification for the hosted app (#46)

The hosted app (`https://pagefirst.io`) shows Google's "unverified app" screen and is capped at 100 users until Google verifies it. This is the checklist and the text to submit. Items marked **Will** need the project owner's Google account.

## Scopes

| Scope | Class | Why Pagefirst needs it |
| --- | --- | --- |
| `openid`, `email`, `profile` | Non-sensitive | Identify the account |
| `https://www.googleapis.com/auth/drive.file` | Non-sensitive | Create the site folder, upload images, open Docs the user picks |
| `https://www.googleapis.com/auth/documents` | **Sensitive** | Read and write the structure of Docs |

No restricted scope (`drive`, `drive.readonly`, `drive.metadata`) is requested, so no CASA security assessment is required. Do not add one without reading the [restricted scope rules](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

`documents` stays because `drive.file` alone cannot call `documents.get` or `documents.batchUpdate`, which are the product. Existing Docs enter through the Google Picker (#15), which grants `drive.file` on exactly the picked file.

### Scope justification (paste into the form)

> Pagefirst lets a user write a web page in a Google Doc and publish it as a static site. It calls `documents.get` to read the Doc the user opens, and `documents.batchUpdate` to write the user's edits back when they press Commit. It cannot see other Docs: Drive access is `drive.file` only, limited to files Pagefirst created or the user picked with the Google Picker. We use the data only to provide these features, never for advertising, and never to train AI models. See https://pagefirst.io/privacy.

## Checklist

1. **Domain.** Decided: `pagefirst.io`. The app runs on the apex. **Will:** verify the domain in Google Search Console with the same Google account that owns the Cloud project, and add it under *Branding → Authorized domains*.
2. **Homepage and privacy policy.** The privacy policy is `https://pagefirst.io/privacy` (source: `app/privacy/page.tsx`), with the Limited Use disclosure. Set both URLs under *Branding*. The homepage must be reachable without signing in and describe what the app does.
3. **Brand verification.** **Will:** set the app name, support email and logo (120×120 PNG) under *Branding*. The name must match the homepage.
4. **Consent screen.** Publishing status *In production*, user type *External*. Add only the five scopes above under *Data Access*.
5. **Redirect URI.** `https://pagefirst.io/api/auth/callback`, exactly. Remove localhost and Vercel preview URIs from the production client.
6. **Demo video.** Record it (script below), upload to YouTube as *Unlisted*, and link it in the form.
7. **Submit.** *Verification Center → Submit for verification*, paste the justification above, answer Google's follow-up email within a few days.

## Demo video script

Google wants to see the OAuth consent screen with the client id in the address bar, then each feature that uses a sensitive scope. Narrate in English; screen-record at 1080p.

1. Show the browser address bar on `pagefirst.io` and click **Sign in with Google**.
2. On the consent screen, keep the URL with `client_id=` visible; show the requested permissions, then Allow.
3. Open or create a page. Show it loading from the Doc (`documents.get`).
4. Edit a heading, press **Commit**, then open the Google Doc and show the change landed (`documents.batchUpdate`).
5. Pick an existing Doc with the Picker and show only that Doc becomes available (`drive.file`).
6. Publish and open the public address.
7. Show Google Account → Security → Third-party access → Pagefirst → Remove access, to demonstrate revocation.

## Known gaps

- The Picker integration (#15) needs `GOOGLE_PICKER_API_KEY` and `GOOGLE_CLOUD_PROJECT_NUMBER`. Until it ships, step 5 of the video cannot be recorded.
- The privacy policy points users to GitHub issues for requests. Add a monitored support email under *Branding* and in the policy before submitting, because Google emails that address.
- Dedicated instances in a customer's own Workspace, set to *Internal*, skip verification entirely (see `infra/instance/README.md`).
