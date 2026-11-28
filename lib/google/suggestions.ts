import type { DocsDocument } from "@/lib/page/types";

/**
 * Pending suggested edits in a Doc (docs/adr/0006-import-model.md). A suggestion
 * is not content yet, so importing or publishing around one would silently drop
 * it. The Docs API marks suggested text with `suggestedInsertionIds` and
 * `suggestedDeletionIds`; this counts the distinct suggestions.
 */
export function countSuggestions(doc: DocsDocument): number {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if ((key === "suggestedInsertionIds" || key === "suggestedDeletionIds") && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") ids.add(id);
      } else {
        visit(child);
      }
    }
  };
  visit(doc.body);
  return ids.size;
}
