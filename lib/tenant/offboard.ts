import { query } from "@/lib/db/client";
import { removeAllSiteDomains } from "@/lib/domains/service";
import { r2Configured, removeSiteFile } from "@/lib/publish/r2";
import { deleteOrganization } from "./orgs";

/**
 * Closing an organization (#45): its published files are removed from the
 * sites bucket first, then its data and the Google grants of members who
 * belong to nothing else. If storage fails the organization is left intact, so
 * the owner can try again; deleting an already missing object is fine.
 */
export async function closeOrganization(orgId: string): Promise<{ sites: number; files: number }> {
  const sites = await query<{ id: string }>("SELECT id FROM sites WHERE org_id = $1", [orgId]);
  let files = 0;
  if (r2Configured()) {
    for (const site of sites) {
      // Domains first: serving stops and the provider hostnames go before the site's files.
      await removeAllSiteDomains(site.id);
      const recorded = await query<{ key: string }>("SELECT key FROM site_files WHERE site_id = $1", [site.id]);
      for (const file of recorded) {
        await removeSiteFile(site.id, file.key);
        files += 1;
      }
    }
  }
  await deleteOrganization(orgId);
  return { sites: sites.length, files };
}
