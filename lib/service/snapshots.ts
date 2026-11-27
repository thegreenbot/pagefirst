import type { Page } from "@/lib/page/types";
import { recordSnapshot, type SnapshotSource } from "@/lib/snapshots/store";
import type { GoogleClient, ServiceContext } from "./context";

/**
 * Stores a snapshot of a live page after a commit, public publish or import
 * (#29). Best effort: a failure here is logged and never reaches the caller,
 * so a Doc that was written is never reported as failed.
 */
export async function snapshotPage(ctx: ServiceContext, google: GoogleClient, page: Page, source: SnapshotSource): Promise<void> {
  try {
    let docModifiedTime: string | null = null;
    let modifiedBy: string | null = null;
    if (ctx.googleToken && google.driveMeta) {
      try {
        const meta = await google.driveMeta(ctx.googleToken, page.fileId);
        docModifiedTime = meta.modifiedTime;
        modifiedBy = meta.lastModifiedBy?.email ?? meta.lastModifiedBy?.name ?? null;
      } catch {
        // The snapshot is still useful without Drive's metadata.
      }
    }
    await recordSnapshot({ page, source, actorSub: ctx.actor.sub, docModifiedTime, modifiedBy });
  } catch (error) {
    console.error("snapshot failed", ctx.requestId, error instanceof Error ? error.name : "unknown");
  }
}
