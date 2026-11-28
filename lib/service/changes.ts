import type { ChangedInDoc, PageSummary } from "@/lib/page/types";
import { baseSnapshot, latestSnapshotTimes } from "@/lib/snapshots/store";

/**
 * "Changed in Google Doc" detection (#30, docs/adr/0006-import-model.md).
 *
 * Site level: the listing already carries each Doc's Drive `modifiedTime`
 * (one `files.list`), so changed pages are found by comparing it with the
 * newest snapshot, with no Docs call per page. Page level: the Doc's current
 * revision against the base snapshot's.
 */

/**
 * Marks each summary `changed` when its Drive modified time is later than when
 * the base snapshot was taken. A Doc with no snapshot is left unmarked: Pagefirst
 * has no base to compare it with.
 */
export async function annotateChanged(pages: PageSummary[]): Promise<PageSummary[]> {
  const times = await latestSnapshotTimes(pages.map((page) => page.fileId));
  return pages.map((page) => {
    const base = times.get(page.fileId);
    if (!base || !page.modifiedTime) return page;
    // The snapshot's own Drive time when it has one, else when we took it.
    const since = Date.parse(base.docModifiedTime ?? base.createdAt);
    const modified = Date.parse(page.modifiedTime);
    if (Number.isNaN(since) || Number.isNaN(modified)) return page;
    return { ...page, changed: modified > since };
  });
}

/** The page-level answer: null unless the Doc's revision differs from the base snapshot's. */
export async function changedInDoc(
  fileId: string,
  currentRevisionId: string,
  meta: () => Promise<{ modifiedTime: string | null; modifiedBy: string | null }>,
): Promise<ChangedInDoc | null> {
  const base = await baseSnapshot(fileId);
  if (!base || !currentRevisionId || base.revisionId === currentRevisionId) return null;
  let found: { modifiedTime: string | null; modifiedBy: string | null } = { modifiedTime: null, modifiedBy: null };
  try {
    found = await meta();
  } catch {
    // Who and when are nice to have; the fact that it changed is not.
  }
  return { baseRevisionId: base.revisionId, ...found };
}
