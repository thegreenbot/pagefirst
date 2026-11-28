import { query } from "@/lib/db/client";
import { splitName } from "./trusted-publishing";

/**
 * Outside theme publishers (#68). Only a system administrator can add one:
 * the publisher gets a scope (`@slug/`) bound to one GitHub repository, and
 * only that repository's publish workflow can submit versions under it.
 */

export class PublisherError extends Error {}

export type Publisher = { slug: string; repository: string; invitedBy: string; createdAt: string; revokedAt: string | null };

const SLUG = /^[a-z0-9][a-z0-9-]{1,38}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

type Row = { slug: string; repository: string; invited_by: string; created_at: Date; revoked_at: Date | null };
const fromRow = (row: Row): Publisher => ({
  slug: row.slug,
  repository: row.repository,
  invitedBy: row.invited_by,
  createdAt: row.created_at.toISOString(),
  revokedAt: row.revoked_at?.toISOString() ?? null,
});

export async function invitePublisher(slug: string, repository: string, invitedBy: string): Promise<Publisher> {
  if (!SLUG.test(slug)) throw new PublisherError("The scope must be 2-39 lowercase letters, digits and dashes.");
  // `@pagefirst` is first-party and `@org-…` is each organization's private scope.
  if (slug === "pagefirst" || slug.startsWith("org-")) throw new PublisherError(`@${slug} is reserved.`);
  if (!REPOSITORY.test(repository)) throw new PublisherError("The repository must look like owner/name.");
  const rows = await query<Row>(
    `INSERT INTO theme_publishers (slug, repository, invited_by) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING *`,
    [slug, repository.toLowerCase(), invitedBy],
  );
  if (!rows[0]) throw new PublisherError("That scope or repository is already taken.");
  return fromRow(rows[0]);
}

/** Revoking stops new submissions; versions already approved stay listed (yank them to remove). */
export async function revokePublisher(slug: string): Promise<boolean> {
  const rows = await query<{ slug: string }>("UPDATE theme_publishers SET revoked_at = now() WHERE slug = $1 AND revoked_at IS NULL RETURNING slug", [slug]);
  return rows.length > 0;
}

export async function listPublishers(): Promise<Publisher[]> {
  return (await query<Row>("SELECT * FROM theme_publishers ORDER BY created_at DESC")).map(fromRow);
}

/** The repository allowed to publish under a theme name's scope, or null when the scope has no active invite. */
export async function publisherRepositoryFor(name: string): Promise<string | null> {
  const scope = splitName(name)?.scope;
  if (!scope) return null;
  const rows = await query<{ repository: string }>("SELECT repository FROM theme_publishers WHERE slug = $1 AND revoked_at IS NULL", [scope]);
  return rows[0]?.repository ?? null;
}
