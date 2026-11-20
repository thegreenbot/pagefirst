# Plan: page-first editing with a Google Doc as the source of truth

The two attached notes (the EDS reverse-engineering writeup and its README) were not readable in this session. This plan is built from the product described alongside them, and from the public Edge Delivery Services document model: sections, default content, table blocks, and a metadata table. See [Document structure](https://experienceleague.adobe.com/en/docs/experience-manager-learn/sites/edge-delivery-services/developing/document-structure) and the [DA source API](https://docs.da.live/developers/api/source).

## What we are building

An author signs in with Google and edits a page that looks like the published page. They can change words, place images, and change layout. Nothing reaches the Doc until they commit. Publish takes the last committed revision, renders static HTML, CSS, and assets, and uploads that snapshot to Cloudflare. Readers of the public site never authenticate.

Three stores, with one writer each:

| Store | Holds | Written by |
| --- | --- | --- |
| Google Doc | The canonical page | Commit |
| Editor draft | Uncommitted page structure | Typing, image placement, layout |
| Cloudflare | Static HTML, CSS, and copied assets | Publish |

## What EDS does, and the piece this app adds

EDS document authoring is doc-first. An author writes in a Google Doc. Preview fetches the doc, turns it into HTML, and serves it. Publish copies that result to the CDN. The Doc stays the source, and the author does not edit the rendered page.

DA.live is page-first. Its editor (ProseMirror) loads HTML from the DA source API and writes HTML back. Preview (`aem.page`) and publish (`aem.live`) are separate steps after that write. The source of truth is HTML, not a Google Doc.

This app is the combination of those two: the DA editing gesture, with the EDS source of truth. The preview is a draft. The Doc is canonical. The CDN is a snapshot of one revision and is never read back into the Doc.

## The rule that keeps it honest

Every feature speaks one intermediate page structure. The editor mutates that structure. Commit translates it into Google Docs API requests. Publish renders it to static files. The preview DOM is not saved, and it is not what gets published.

After every successful commit the server re-reads the Doc and returns the parsed page. The client throws away its optimistic draft and renders that result. That re-read is what stops the editor and the Doc from drifting.

## Page structure

The structure matches what a person sees if they open the Google Doc, which is the same shape EDS already parses.

```ts
type Page = {
  fileId: string;
  revisionId: string;
  path: string;                         // from the Drive folder, index for a doc named index
  metadata: Record<string, string>;     // title, description, image, template, theme
  sections: Section[];
};

type Section = {
  id: string;
  style: string[];                      // from a section-metadata table
  children: Node[];
};

type Node = Prose | Block;

type Prose = {
  kind: "prose";
  id: string;
  tag: "h1" | "h2" | "h3" | "h4" | "p" | "ul" | "ol" | "img";
  text?: string;
  items?: string[];                     // list items
  image?: { driveFileId: string; alt: string };
};

type Block = {
  kind: "block";
  id: string;
  name: string;                         // hero, columns, cards
  options: string[];                    // the parenthetical on the name cell
  rows: Cell[][];                       // rows under the name row
};

type Cell = { id: string; children: Prose[] };
```

### How a node sits in the Doc

| Page node | What the author sees in the Doc | How commit addresses it |
| --- | --- | --- |
| Section break | A paragraph whose entire text is `---` | Named range `pg/section/{id}` on that paragraph |
| Prose | A heading, paragraph, list, or inline image | Named range `pg/node/{id}` |
| Block | A table. First row is one cell, `hero` or `columns (contained)` | Named range on the whole table |
| Block options | The parenthetical in the name cell | Rewrite that cell's text |
| Page metadata | A two-column table whose first cell is `metadata` | Named range `pg/meta`. Not rendered as a block |
| Section style | A table named `section metadata` at the end of a section | Named range on that table |
| Image bytes | An inline image. The Doc stores the bytes after insert | Drive file is only the upload source |
| Title | The first `h1`. Copied into `metadata.title` on read when that key is empty | Editing the title writes the heading |

Ids live in named ranges, not in visible text. A person reading the Doc sees ordinary headings, paragraphs, and tables.

On the first commit of a doc that has no ranges, the server creates the ranges and changes no visible content. That is the adopt step. Later commits resolve a range to a current index. Indexes from a previous response are never reused. Google shifts them on every edit.

Anything the parser does not understand (a comment, a drawing, an unsupported table, a suggestion) is an opaque span. A commit that would overlap an opaque span is rejected. The writer never replaces the whole document body, so those spans survive.

### Fixture the first slice has to round-trip

Visible contents of the fixture Doc:

```
About the studio

A one-paragraph introduction.

---

hero
The work, plainly described.
(an inline image)

---

columns (contained)
Left column | Right column
First point. | Second point.

metadata
title | About
description | What the studio ships.
template | page
```

Expected page: two sections after the title section, one `hero` block, one `columns` block with option `contained`, and four metadata entries. The metadata table does not appear in the preview.

## Authentication

Google is the account system. There is no second user table and no password.

OAuth authorization-code with PKCE. Scopes:

- `openid`, `email`, `profile` — who is signed in
- `https://www.googleapis.com/auth/documents` — read and write document structure
- `https://www.googleapis.com/auth/drive.file` — files this app created, plus files the user picks

`drive.file` cannot see the rest of Drive. A site is a folder the app creates, so every doc inside it is in scope. A doc that already exists is opened through the Google Picker, which grants `drive.file` on that file. The app does not ask for full Drive access.

The access token is stored in an httpOnly cookie. Publish and commit are actions the signed-in person takes, so an access token is enough. There is no database in the first four slices. A refresh-token store waits until something has to publish without the person present.

Permission check: every read and write uses that person's token. A 403 from Google is the answer. The app does not keep its own ACL.

## Editor

The preview is the page, with editing chrome on focus. Three operations, because each one has a single Doc write:

1. **Words.** The text of a prose node or a table cell. Styles the author can apply are the semantic ones the Doc already has: heading level, paragraph, list. Visual design comes from the site CSS, not from fonts stored on the run.
2. **Images.** Drop or pick a file. The server uploads the bytes to the site's `media` folder in Drive and returns the file id. The draft points at that id. Commit inserts it into the Doc (see the image constraint below). Alt text is an edit of its own.
3. **Layout.** Reorder sections, reorder or insert or remove blocks, change a block's options, split or join sections at a `---` break. The block palette for the first version is prose, `hero`, `columns`, and `cards`.

Free positioning on the page has no representation in a Doc, so it is not an operation.

The draft lives in the browser until commit. Keystrokes do not call the Docs API. That keeps commit meaningful, and it stays out of the way of someone who has the same Doc open in Google.

### Image constraint

`documents.batchUpdate` `insertInlineImage` fetches a URL once and stores the bytes in the Doc. The URL has to be fetchable by Google at that moment, and a `drive.file` object is not public.

Commit therefore does this: share the Drive file as "anyone with the link", call `insertInlineImage` with that URL, then delete the share. After that the Doc holds the bytes. The preview never hotlinks Drive for the public site. While editing, the editor loads image bytes through a server route that uses the user's token. Publish copies those bytes out of the Doc response into the asset bucket and rewrites the URL. A published page does not depend on Drive.

## Commit

The client sends the revision it started from and a list of operations:

```ts
type Commit = {
  fileId: string;
  baseRevisionId: string;
  ops: Op[];
};

type Op =
  | { op: "replaceText"; nodeId: string; text: string }
  | { op: "setBlockOptions"; nodeId: string; options: string[] }
  | { op: "setMetadata"; key: string; value: string }
  | { op: "insertBlock"; sectionId: string; index: number; block: Block }
  | { op: "insertSection"; index: number }
  | { op: "removeNode"; nodeId: string }
  | { op: "moveNode"; nodeId: string; toSectionId: string; index: number }
  | { op: "setImage"; nodeId: string; driveFileId: string; alt: string };
```

Server sequence:

1. `documents.get` with the user's token.
2. If `revisionId` differs from `baseRevisionId`, return 409 and the freshly parsed page. The client keeps the draft on screen and offers to reload. The first version does not merge.
3. Resolve every `nodeId` through its named range. Reject the commit if any op overlaps an opaque span.
4. Build `batchUpdate` requests. Apply index-sensitive requests from the highest index downward. When an insert's index depends on a range created earlier in the same commit, split into a second batch and re-read ranges in between.
5. Re-read the Doc. Return the new `revisionId` and the parsed page.

Moving a block is a reconstruction, not a native move: the API has no move. The server reads the table, inserts the equivalent table at the destination, re-inserts any images from their bytes, and deletes the original range. This is why layout is a later slice than text. Text never needs to reconstruct a table.

A commit of zero operations is a no-op and does not bump the revision the client stores.

## Publish

Publish is a function of the page at one revision and the site theme. It refuses to run when the editor has uncommitted operations.

1. Load that revision and parse it.
2. Render with the same function the editor uses, in `mode: "publish"`. Editor attributes (`contenteditable`, draft ids, selection) are not in this output.
3. Copy every image the page references into content-addressed files. Rewrite image URLs to those files.
4. Upload the directory.
5. Record a manifest entry `{ path, revisionId, publishedAt }`.

Locally, with no Cloudflare token, publish writes `./out` and the dev server can serve it. With `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, publish uses Cloudflare Pages Direct Upload. Assets are immutable and cached for a long time. HTML is purged on that URL at the end of the upload.

Uploading the same `revisionId` for the same path a second time does not upload again.

Two hostnames (a shareable preview versus production) wait until a second person needs a link. Until then the editor is the preview, and Publish is what updates the public site. That matches the EDS split of preview and live, without standing up a second pipeline before one page works.

## App shape

Next.js and TypeScript. One render function imported by the editor and by the publisher, so the two outputs cannot diverge.

Routes:

| Route | Behavior |
| --- | --- |
| `/` | Lists docs in the site folder. Creating a page copies a template Doc into that folder. |
| `/edit/[fileId]` | The page editor. |
| `GET /api/pages/[fileId]` | Doc to page structure. |
| `POST /api/pages/[fileId]/commit` | Operations to `batchUpdate`, then re-read. |
| `POST /api/pages/[fileId]/publish` | Render and upload. |
| `POST /api/media` | Upload bytes to the site `media` folder, return the Drive file id. |
| `GET /api/media/[fileId]` | Proxy image bytes for the editor, using the user's token. |

The publisher's HTML follows the EDS shape so a block stylesheet ports later: a `main`, a `div.section` per section, default content as headings and paragraphs, and a `div.{blockName}` per block.

## Slices

Each slice is done only when its check passes against a real Google Doc. A slice does not start by mocking the Docs API and leaving the real call for later.

### 1. Read path

Sign-in, Picker, `documents.get`, parser for prose, `---` sections, the metadata table, and a single table block. Read-only preview of the fixture.

Done when the fixture renders as specified above, and opening a Doc the account cannot edit shows the Google error instead of an empty page.

### 2. Words

Adopt creates named ranges. Inline text edits commit. The server re-reads and the client renders the result.

Done when the new sentence is visible in the Google Doc itself, and a second edit made in Google Docs between load and commit returns 409 without writing.

### 3. Images and layout

Upload, place, and replace an image. Reorder sections and blocks. Insert and remove `hero`, `columns`, and `cards`. Change a block option.

Done when the table order in the Doc matches the preview after a reorder, the image displays from bytes stored in the Doc after the temporary share is removed, and a comment that was on the Doc before the session is still there after commit.

### 4. Publish

Static render, local `./out`, Cloudflare Direct Upload when the token is present, manifest keyed by revision, HTML purge.

Done when the public URL shows the page with no editor chrome and no Google sign-in, the image URL is on the asset host rather than Drive, and publishing that same revision again does not upload.

### 5. A site

The Drive folder is the site. `index` is the home page. A fragment is a Doc included by reference from a `fragment` block. A Google Sheet named `redirects` maps old paths to new ones. A shared header and footer are fragments, not copies.

Done when two pages include one header fragment, editing that fragment and publishing both pages updates both, and a row in the redirects sheet publishes a redirect.

## Left for later

These have no slice because each one breaks the Doc as a readable source, or needs a store we do not have yet:

- Real-time collaboration inside the preview. Two people use the Google Doc for that. The editor is one writer plus the revision check.
- Comments, suggestions, arbitrary fonts, drawings, page breaks.
- Nested blocks. A block inside a block makes the write-back ambiguous, and EDS does not nest them either.
- Saving the preview DOM and publishing that HTML.
- A user database, a second login, or an ACL that can disagree with Google.
- Unattended publish, which is the first feature that needs a stored refresh token.

## Risks

| Risk | What we do about it |
| --- | --- |
| Docs indexes shift under us | Named ranges, resolved on each commit. Re-read after every commit. Never reuse an index from a previous response. |
| `drive.file` hides files the user expects to see | The site folder is created by the app. Existing docs enter through the Picker. The first screen says so. |
| `insertInlineImage` needs a public URL | Temporary link share around the single insert call, then the Doc owns the bytes. Publish copies bytes out. |
| A commit drops content the parser skipped | Opaque spans are rejected on overlap. The writer is surgical and never replaces the body. |
| Preview and the public page disagree | One render function, two modes. The slice 4 check diffs publish HTML against the preview's semantic HTML with editor attributes removed. |
| A dirty draft gets published | Publish refuses while operations are uncommitted, and it loads the revision from Google rather than from the draft. |

## Decisions already made

| Topic | Decision |
| --- | --- |
| Identity | Google OAuth only. Edit rights are the Doc's rights. |
| Scopes | `openid`, `documents`, `drive.file`. Picker for existing files. |
| Canonical store | The Google Doc. |
| When the Doc changes | On commit, not on keystroke. |
| Anchors | Named ranges `pg/section/{id}`, `pg/node/{id}`, `pg/meta`. |
| Layout model | Sections, blocks, and options. |
| First block palette | Prose, `hero`, `columns`, `cards`, plus the metadata table. |
| Renderer | One function, `mode: "edit"` or `mode: "publish"`. |
| CDN | Cloudflare Pages Direct Upload. Local `./out` when the token is absent. |
| Shareable preview host | After slice 4. The editor is the preview until then. |
| Database | None until unattended publish. |
| Conflict policy | 409 and reload. No merge in the first version. |
| Stack | Next.js and TypeScript, when implementation starts. |
