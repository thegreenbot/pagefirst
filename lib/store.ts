import { randomUUID } from "node:crypto";
import { requestIdFrom } from "@/lib/audit";
import type { CommitResult, Library, Op, PagePayload } from "@/lib/page/types";
import * as service from "@/lib/service";
import { ServiceError, type ServiceContext } from "@/lib/service";
import { getAccessToken, getSessionSub } from "@/lib/session";

/**
 * The browser adapter for the page service (#11): resolves the signed-in user
 * from the session cookie into an explicit context, then calls lib/service.
 * The REST API, MCP server and background jobs build their own contexts.
 */
export async function sessionContext(request?: Request): Promise<ServiceContext> {
  const googleToken = await getAccessToken();
  return {
    actor: { sub: googleToken ? await getSessionSub() : null, client: "ui" },
    googleToken,
    requestId: request ? requestIdFrom(request) : randomUUID(),
  };
}

export async function isSampleMode(): Promise<boolean> {
  return service.isSampleContext(await sessionContext());
}

export async function listPages(): Promise<Library> {
  return service.listPages(await sessionContext());
}

export async function getPage(fileId: string): Promise<PagePayload | null> {
  return service.getPage(await sessionContext(), fileId);
}

export async function createPage(title: string): Promise<PagePayload> {
  return service.createPage(await sessionContext(), title);
}

export async function commitPage(fileId: string, baseRevisionId: string, ops: Op[]): Promise<CommitResult> {
  try {
    return await service.commit(await sessionContext(), fileId, baseRevisionId, ops);
  } catch (err) {
    if (err instanceof ServiceError) return { ok: false, status: err.status, code: err.code, error: err.message };
    throw err;
  }
}

