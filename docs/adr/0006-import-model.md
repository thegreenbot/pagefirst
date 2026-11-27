# ADR 0006: Importing Doc changes back into Pagefirst

- Status: accepted (the proposals in #28, approved with the board)
- Date: 2026-11-27
- Issues: #8 (epic), #28; blocks #29, #31, #32, #33, #34, #42

## Context

The Google Doc is canonical, and people edit it directly: copy editors, audit teams, anyone who prefers Docs. Pagefirst today refuses to touch a page whose Doc changed under it (`revision_conflict`, no merge). Teams that review content in Docs need those edits to flow into the page, be reviewed as a change list, and publish, without retyping, and an agent or audit job needs the same flow over the API.

## Decisions

### Base revision

An import diffs the Doc's current content against a **base snapshot**: the parsed page as of the last revision Pagefirst committed *or* published for that Doc, whichever is newer. The snapshot is stored (#29) as `{ fileId, revisionId, page JSON, source: commit | publish | import, actor, contentHash, createdAt }`. A Doc Pagefirst has never touched has no base; its first import adopts everything as new (see Adopt) and records the first snapshot.

Google revision ids are opaque and are not diffable by themselves, which is why the base is our own parsed snapshot, not a Drive revision.

### Unit of change

The unit is the **node**, keyed by the named-range id (`pg/node/{id}`, `pg/section/{id}`, `pg/meta`): a prose node, a block, a block cell, a section, or a metadata key. A change list (#31) reports, in a stable serialisable form:

`node.added`, `node.removed`, `node.moved`, `prose.text` (with a word-level text diff for display), `prose.tag`, `block.options`, `cell.content` (row and column addressed), `section.added`, `section.removed`, `section.style`, `meta.set`, `meta.removed`, `image.changed`, `node.untracked` (content in the Doc with no named range).

Text changes inside a node are shown as a text diff for review but **merged as a whole-node replacement**: there is no character-level three-way merge. If both sides changed the same node, that is a conflict, not a merge.

### Three sides

A merge (#33) has three inputs: the **base** snapshot, the **Doc** now (parsed), and the **local draft** (the editor's uncommitted ops, when there is one; API and job callers have none). Per node:

| Base vs Doc | Base vs draft | Result |
| --- | --- | --- |
| unchanged | unchanged | keep |
| changed | unchanged | take the Doc |
| unchanged | changed | keep the draft (it commits later) |
| changed | changed, same value | keep (no conflict) |
| changed | changed, different | conflict, resolved by policy |

### Conflict policy

Chosen per request, with these defaults:

- `manual`: report the conflict and apply nothing for that node. Default in the editor.
- `doc-wins`: take the Doc's value. Default for automated audits and bulk jobs.
- `draft-wins`: keep the draft's value.
- `fail`: the whole import stops with `revision_conflict` if any conflict exists.

PLAN.md's "409 and reload, no merge in the first version" is superseded by this. Commit still returns `revision_conflict` when its base is stale; import is the path that reconciles.

### What import never does

- It **never writes to the Doc**, except the **adopt** step: adding named ranges around content that has none, which changes no visible text (#32).
- It **never publishes**. Publishing is a separate, explicit call with a pinned revision (#34); `import_and_publish` runs the two as separate recorded steps, publishing only the revision the import produced and that a reviewer or policy accepted.
- It never deletes a node that the Doc still contains.

### Opaque content

Comments, suggestions, drawings, and tables Pagefirst does not model are **reported, not imported**: they appear in the change list as `opaque` with their location. A Doc with pending **suggestions** is the exception that matters: suggested edits are not yet content, so importing would silently drop them. A publish of a revision with pending suggestions is **blocked** by default and can be allowed explicitly with a warning recorded in the audit log.

### Attribution

For each import record who changed the Doc and when, from Drive `revisions.list` (`lastModifyingUser`, `modifiedTime`), in the import's audit event. Whether `drive.file` returns `lastModifyingUser` for a Doc the app has opened must be checked against a real account (the spike harness in `claude/confident-davinci-epmzus` is the place); when it does not, the audit says `unknown` and still records `modifiedTime` from the file.

### Detection

"Changed in Google Doc" (#30) is `modifiedTime` newer than the base snapshot's `createdAt`-time of the Doc, read from one Drive `files.list` per site, not one `documents.get` per page. A Doc that Pagefirst itself just wrote is not "changed": the snapshot taken after each commit records the Doc's resulting `modifiedTime`.

### Dry run first

Every import has a dry-run form that returns the change list, the conflicts and what the policy would do, and writes nothing. In the API and MCP, `dryRun` defaults to `true` for import.

## Consequences

- The snapshot table grows with every commit and publish; retention keeps the last published snapshot forever and prunes the rest (#29).
- Whole-node replacement means two people editing different sentences of one paragraph conflict. That is accepted for the first version: it is predictable and reviewable, and a character-level merge can be added behind the same policy names.
- Detection by `modifiedTime` can flag a Doc whose only change was a no-op edit; the diff then comes back empty and the page is cleared.
