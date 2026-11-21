# Spike: can Google govern site edit access under `drive.file`?

## Why

The multi-site plan says a site editor is any signed-in account that Google says can edit the site's root folder or the Doc, and that the app enforces this with the caller's own token. The app requests these scopes (`lib/google/oauth.ts`):

- `drive.file` — Drive access limited to files this app created or the user opened with this app.
- `documents` — the Docs API scope. It may reach **every** Doc the user can open, regardless of `drive.file`.

So the spike measures the **Drive API** (listing a folder, `capabilities`, `parents`) and the **Docs API** (read, write) separately. The plan depends on what each one sees for a second account.

## Hypotheses

| # | Hypothesis | Probe that tests it |
|---|---|---|
| H1 | Account B (shared as editor in Drive, never used Picker) **cannot** see A's app-created root folder through the Drive API. | `drive.files.get root` as B |
| H2 | B **can** read and write a Doc in that folder through the Docs API, because of the `documents` scope. | `docs.documents.get`, write probe as B |
| H3 | After B picks the **root folder** with the Picker, B can get the folder but **not** list or get its children. | `drive.files.get root`, `drive.files.list children` as B after Picker |
| H4 | After B picks a **Doc** with the Picker, B can read its `capabilities.canEdit` but cannot walk its parents to the root. | `drive.files.get doc`, `parent walk` as B |
| H5 | A cannot see through the Drive API a Doc that A created in the Drive UI (not through the app), even inside the app-created root. | `drive.files.get doc` and `children` as A |
| H6 | `capabilities.canEdit` reflects a Viewer share (false) once the file is visible. | `drive.files.get` as C (viewer) after Picker |

Write the observed result next to each one. A surprise is the point of a spike.

## Setup

1. Two Google accounts, **A** and **B**, both listed as test users on the OAuth consent screen. A third account **C** is optional, for H6.
2. In the Google Cloud project for `GOOGLE_CLIENT_ID`:
   - Enable the **Google Picker API**, the **Google Drive API**, and the **Google Docs API**.
   - Create an **API key** restricted to the Picker API and to HTTP referrer `http://127.0.0.1:3847/*`.
   - Note the **project number**. That number is the Picker `appId`.
3. Add these to `.env.local`, which is git-ignored:

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   PAGEFIRST_SPIKE=1
   SPIKE_PICKER_API_KEY=...
   SPIKE_PICKER_APP_ID=...   # project number
   ```

4. Start the app and open `http://127.0.0.1:3847/spike/drive`:

   ```bash
   npm run dev
   ```

The spike page and its `/api/spike/*` routes return 404 unless `PAGEFIRST_SPIKE=1`. They always return 404 on a Vercel production deploy. The token route hands the OAuth token to browser JavaScript, because the Picker needs it. Product code never does this.

Sign in with **Sign in / switch account**. Sign-in returns you to `/`, so go back to `/spike/drive` afterwards. Use **Sign out** before you switch accounts.

## Steps

Each probe result is a JSON entry in the log on the page. Copy the relevant lines into the results table below.

### As A

1. **Create root folder** named `pf-spike-root`. Copy its id into *Root folder id*.
2. **Create folder in root** named `pf-spike-sub`. Note its id.
3. **Create doc in root** named `pf-doc-app`. Note its id as `DOC_APP`.
4. Set *Root folder id* to the sub-folder id, then **Create doc in root** named `pf-doc-nested` (`DOC_NESTED`). Set *Root folder id* back to the root.
5. In the Drive web UI, open `pf-spike-root` and create a Google Doc named `pf-doc-manual` (`DOC_MANUAL`). Copy its id from the URL.
6. **Run probes** with root plus `DOC_NESTED`. Expect everything to work and the parent walk to reach the root. This is the control.
7. **Run probes** with root plus `DOC_MANUAL`. This tests H5.
8. In the Drive web UI, share `pf-spike-root` with **B as Editor**, and with **C as Viewer** if you have a third account.

### As B, no Picker

9. **Run probes** with root plus `DOC_APP`. This tests H1 and H2.
10. **Write probe on doc** with `DOC_APP`. This tests H2 for writes.

### As B, after Picker

11. **Picker: folder**, then choose `pf-spike-root`. **Run probes** with root only. This tests H3.
12. **Picker: doc**, then choose `DOC_NESTED`. **Run probes** with root plus that doc. This tests H4: is the parent walk blocked at `pf-spike-sub`?
13. **Run probes** with root plus `DOC_APP`, which B didn't pick. Did picking the folder grant its children?

### As A, after B picked the folder

14. **Create doc in root** named `pf-doc-late`. Then, as B, **Run probes** with root plus `pf-doc-late`. Can B see a file created after B's Picker grant?

### As C (optional)

15. **Picker: doc** with `DOC_APP`. **Run probes**, then **Write probe**. This tests H6: expect `canEdit` false and the write to return 403.

## Results

Fill in the HTTP status and the key fields, for example `canEdit`, `files` count, and `reachedRoot`.

| Step | Account | Probe | Expected | Observed |
|---|---|---|---|---|
| 6 | A | drive get root / children / doc / parent walk | 200 / 2+ items / 200 / reached | |
| 7 | A | drive get `DOC_MANUAL` · children includes it? | 404 · no | |
| 9 | B | drive get root | 404 | |
| 9 | B | docs get `DOC_APP` | 200 | |
| 10 | B | write `DOC_APP` | 200 | |
| 11 | B | drive get root · list children (picked folder) | 200 · ? | |
| 12 | B | drive get `DOC_NESTED` · parent walk | 200 · stops at sub? | |
| 13 | B | drive get `DOC_APP` (unpicked) | ? | |
| 14 | B | drive get `pf-doc-late` | ? | |
| 15 | C | `canEdit` · write | false · 403 | |

## What each outcome means for the plan

- **H2 holds (the Docs API works for B without the Picker).** Docs edits are already gated by Google. The editor can rely on the Docs API returning 403 for writes. A read with a `canEdit` check through Drive only works once the file is visible to the app.
- **H1 and H3 hold (no folder visibility, or no child listing, even after the Picker).** "Site editors are whoever can edit the root folder" can't be checked under `drive.file` alone. In that case the options are:
  1. **Widen the scope** to `drive.readonly` (metadata and listing) or `drive`. Both are *restricted* scopes, which need Google's verification and a security assessment before you can have more than the test users. They make folder membership and ancestry checks trivial.
  2. **`drive.metadata.readonly`** for listing, `capabilities` and `parents` without file content. It's also restricted, I believe. Confirm in the Cloud console when you add it.
  3. **Stay on `drive.file`, with the site index kept by the app.** Every Doc in a site is created through the app, so the app records `fileId → siteId` in KV when it creates the Doc. Edit rights per Doc come from the Docs API (H2) plus `capabilities` on files the app created. Docs made outside the app enter through the Picker. Containment is checked against the app's own index instead of Drive `parents`.
- **H3 is false (a picked folder grants its children).** Each editor does one Picker step per site, on first visit. The plan keeps `drive.file`, and "can edit the root folder" becomes the site-editor check.
- **H4 (the parent walk stops at an unpicked sub-folder).** Containment through Drive `parents` won't work under `drive.file`. Use the app's index from option 3.

## Clean up

As A, delete `pf-spike-root` in Drive. Remove `PAGEFIRST_SPIKE` and the Picker key from `.env.local`. Delete the API key in the Cloud console, or keep it if the Picker will ship.
