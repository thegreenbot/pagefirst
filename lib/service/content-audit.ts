import { analyze, DEFAULT_OPTIONS, toAuditPage, type AuditOptions, type AuditPage, type AuditReport } from "@/lib/content-audit/analyze";
import { getPage, listPages } from "./pages";
import { requireScope, type ServiceContext } from "./context";

/** Docs read per report. The Drive listing is itself capped, and each page is one Docs read. */
export const AUDIT_PAGE_LIMIT = 30;
const CONCURRENCY = 4;

export type AuditRequest = Partial<Pick<AuditOptions, "staleDays" | "thinWords" | "duplicateThreshold">> & { now?: Date };

/** Reads the caller's pages and reports the ones that need a human (#50). Read-only. */
export async function contentAudit(ctx: ServiceContext, request: AuditRequest = {}): Promise<AuditReport & { truncated: boolean; sample: boolean }> {
  requireScope(ctx, "pages:read");
  const options: AuditOptions = { ...DEFAULT_OPTIONS, ...stripUndefined(request), now: request.now ?? new Date() };
  const library = await listPages(ctx);
  const summaries = library.pages.slice(0, AUDIT_PAGE_LIMIT);
  const pages: AuditPage[] = [];
  for (let i = 0; i < summaries.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      summaries.slice(i, i + CONCURRENCY).map(async (summary) => {
        const payload = await getPage(ctx, summary.fileId);
        return payload ? toAuditPage(payload.page, summary.title, summary.modifiedTime, options.now) : null;
      }),
    );
    for (const page of batch) if (page) pages.push(page);
  }
  return { ...analyze(pages, options), truncated: library.pages.length > summaries.length, sample: library.sample };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== undefined && k !== "now")) as Partial<T>;
}
