import type { Page } from "@/lib/page/types";

/**
 * What a caller is allowed to do. Browser sessions hold every scope; API keys
 * and MCP tokens (#36) hold the subset their owner granted. Publish is never
 * implied by commit.
 */
export const SCOPES = ["pages:read", "pages:commit", "pages:import", "pages:publish"] as const;
export type Scope = (typeof SCOPES)[number];

export type Client = "ui" | "api" | "mcp";

/** The Google calls the service makes, so tests and other callers can supply their own. */
export type GoogleClient = {
  listDocuments(token: string, folderIds?: readonly string[]): Promise<{ id: string; name: string }[]>;
  /** The folders a file sits directly in. Needed only to enforce a site-folder allow-list. */
  parentsOf?(token: string, fileId: string): Promise<string[]>;
  fetchDocument(token: string, fileId: string): Promise<import("@/lib/page/types").DocsDocument>;
  createDocument(token: string, title: string): Promise<import("@/lib/page/types").DocsDocument>;
  batchUpdate(token: string, fileId: string, requests: object[]): Promise<unknown>;
};

/**
 * Everything a service call needs, passed explicitly. Nothing in lib/service
 * reads cookies or request headers: an adapter (route handler, API, MCP, job)
 * builds this and calls in.
 */
export type ServiceContext = {
  /** The Google account the call runs as, when known. */
  actor: { sub: string | null; client: Client };
  /** A Google access token for the actor, or null for sample mode. */
  googleToken: string | null;
  requestId: string;
  idempotencyKey?: string;
  /** Granted scopes. Omitted means a full browser session. */
  scopes?: ReadonlySet<Scope>;
  /**
   * Drive folder ids the credential may touch (API keys only). Omitted means
   * any Doc the user can reach. Only Docs directly inside a listed folder match.
   */
  siteFolders?: readonly string[];
  /** Replaces the real Google client, for tests. */
  google?: GoogleClient;
};

export type ServiceErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "rate_limited"
  | "upstream_quota"
  | "upstream_error";

const STATUS: Record<ServiceErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  unsupported: 501,
  rate_limited: 429,
  upstream_quota: 429,
  upstream_error: 502,
};

/** A typed failure. Adapters map `code` to a status; callers never match on message text. */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly page?: Page;
  /** For quota refusals: seconds until the caller should retry (becomes Retry-After). */
  readonly retryAfterSeconds?: number;

  constructor(code: ServiceErrorCode, message: string, options: { page?: Page; retryAfterSeconds?: number } = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = STATUS[code];
    this.page = options.page;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export function hasScope(ctx: ServiceContext, scope: Scope): boolean {
  return ctx.scopes === undefined || ctx.scopes.has(scope);
}

/** Throws `forbidden` unless the caller holds `scope`. Called at the top of every service function. */
export function requireScope(ctx: ServiceContext, scope: Scope): void {
  if (!hasScope(ctx, scope)) throw new ServiceError("forbidden", `This credential lacks the ${scope} scope.`);
}

export function statusForCode(code: ServiceErrorCode): number {
  return STATUS[code];
}
