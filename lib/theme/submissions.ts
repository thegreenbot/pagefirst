import { query } from "@/lib/db/client";
import { describeFindings, type Finding } from "./checks";
import { RegistryError, inspectTheme, loadArchive, publishVersion, type Provenance, type ThemeVersion } from "./registry-store";
import { archiveIntegrity } from "./tarball";

/**
 * Submissions from invited publishers (#68). A submitted version is built in
 * a sandbox (the archive is unpacked and loaded as data, checked, and
 * rendered against the byte budgets; its code never runs on the server) and
 * waits, unlisted, until a system administrator approves it. Approving
 * publishes it as `verified`.
 */

export type SubmissionStatus = "pending" | "approved" | "rejected";
export type Report = { findings: Finding[]; measured: Record<string, unknown>; breaches: { label: string; actual: number; limit: number; unit: string }[] };
export type Submission = {
  id: string;
  name: string;
  version: string;
  integrity: string;
  description: string;
  status: SubmissionStatus;
  report: Report;
  repository: string | null;
  reviewedBy: string | null;
  reason: string | null;
  createdAt: string;
  reviewedAt: string | null;
};

type Row = {
  id: string;
  name: string;
  version: string;
  integrity: string;
  manifest: { description?: string };
  report: Report;
  provenance: { repository?: string };
  status: SubmissionStatus;
  reviewed_by: string | null;
  reason: string | null;
  created_at: Date;
  reviewed_at: Date | null;
};

const COLUMNS = "id, name, version, integrity, manifest, report, provenance, status, reviewed_by, reason, created_at, reviewed_at";

const fromRow = (row: Row): Submission => ({
  id: row.id,
  name: row.name,
  version: row.version,
  integrity: row.integrity,
  description: row.manifest.description ?? "",
  status: row.status,
  report: row.report,
  repository: row.provenance.repository ?? null,
  reviewedBy: row.reviewed_by,
  reason: row.reason,
  createdAt: row.created_at.toISOString(),
  reviewedAt: row.reviewed_at?.toISOString() ?? null,
});

/**
 * Runs the sandbox and, when it passes, queues the version for review. A
 * version that fails is refused outright and nothing is stored.
 */
export async function submitVersion(archive: Uint8Array, provenance: Provenance, scope: string): Promise<Submission> {
  const theme = loadArchive(archive);
  const { name, version } = theme.manifest;
  if (!name.startsWith(`@${scope}/`)) throw new RegistryError(`${name} is outside your scope @${scope}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new RegistryError(`${version} is not a valid version`);
  const report = inspectTheme(theme);
  if (report.findings.length) throw new RegistryError(`${name}@${version} failed the submission checks: ${describeFindings(report.findings)}`);
  if (report.breaches.length) {
    throw new RegistryError(`${name}@${version} is over budget: ${report.breaches.map((b) => `${b.label} ${b.actual} > ${b.limit} ${b.unit}`).join("; ")}`);
  }
  const taken = await query("SELECT 1 FROM theme_versions WHERE name = $1 AND version = $2", [name, version]);
  if (taken.length) throw new RegistryError(`${name}@${version} is already published; versions are immutable`);
  const rows = await query<Row>(
    `INSERT INTO theme_submissions (name, version, integrity, archive, manifest, report, provenance)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING ${COLUMNS}`,
    [name, version, archiveIntegrity(archive), Buffer.from(archive), JSON.stringify(theme.manifest), JSON.stringify(report), JSON.stringify(provenance)],
  );
  if (!rows[0]) throw new RegistryError(`${name}@${version} is already waiting for review`);
  return fromRow(rows[0]);
}

export async function listSubmissions(status: SubmissionStatus | null = "pending"): Promise<Submission[]> {
  const rows = status
    ? await query<Row>(`SELECT ${COLUMNS} FROM theme_submissions WHERE status = $1 ORDER BY created_at DESC LIMIT 200`, [status])
    : await query<Row>(`SELECT ${COLUMNS} FROM theme_submissions ORDER BY created_at DESC LIMIT 200`);
  return rows.map(fromRow);
}

export async function getSubmission(id: string): Promise<Submission | null> {
  const rows = await query<Row>(`SELECT ${COLUMNS} FROM theme_submissions WHERE id = $1`, [id]);
  return rows[0] ? fromRow(rows[0]) : null;
}

export class ReviewError extends Error {}

/** Publishes a pending submission as a verified version. The sandbox runs again inside publishVersion. */
export async function approveSubmission(id: string, reviewer: string): Promise<ThemeVersion> {
  const rows = await query<{ archive: Buffer; provenance: Provenance; status: SubmissionStatus }>(
    "SELECT archive, provenance, status FROM theme_submissions WHERE id = $1",
    [id],
  );
  const row = rows[0];
  if (!row) throw new ReviewError("No such submission.");
  if (row.status !== "pending") throw new ReviewError(`That submission was already ${row.status}.`);
  const published = await publishVersion(new Uint8Array(row.archive), { ...row.provenance, review: { by: reviewer, at: new Date().toISOString() } }, null, undefined, null, "verified");
  await query("UPDATE theme_submissions SET status = 'approved', reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status = 'pending'", [id, reviewer]);
  return published;
}

export async function rejectSubmission(id: string, reviewer: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new ReviewError("Say why, so the publisher can fix it.");
  const rows = await query<{ id: string }>(
    "UPDATE theme_submissions SET status = 'rejected', reviewed_by = $2, reason = $3, reviewed_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
    [id, reviewer, reason.trim().slice(0, 1000)],
  );
  if (!rows[0]) throw new ReviewError("That submission is not pending.");
}
