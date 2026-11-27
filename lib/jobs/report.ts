import type { JobCounts, JobItem, JobRow } from "./store";

/** What a finished or running job did, per page, for audit teams (#40). */

export type JobReport = {
  job: Pick<JobRow, "id" | "kind" | "status" | "dryRun" | "createdAt" | "startedAt" | "finishedAt">;
  counts: JobCounts;
  items: { idx: number; fileId: string; status: string; code: string | null; message: string | null; revisionId: string | null }[];
};

function revisionOf(result: unknown): string | null {
  if (result && typeof result === "object" && "revisionId" in result && typeof (result as { revisionId: unknown }).revisionId === "string") {
    return (result as { revisionId: string }).revisionId;
  }
  return null;
}

export function buildReport(job: JobRow, counts: JobCounts, items: JobItem[]): JobReport {
  return {
    job: { id: job.id, kind: job.kind, status: job.status, dryRun: job.dryRun, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt },
    counts,
    items: items.map((item) => ({ idx: item.idx, fileId: item.fileId, status: item.status, code: item.code, message: item.message, revisionId: revisionOf(item.result) })),
  };
}

/** A spreadsheet opening the file must not run a cell as a formula, so risky leading characters are defused. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function reportCsv(report: JobReport): string {
  const header = ["idx", "fileId", "status", "code", "message", "revisionId"];
  const lines = report.items.map((item) => [item.idx, item.fileId, item.status, item.code, item.message, item.revisionId].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
