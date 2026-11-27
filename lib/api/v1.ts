import { NextResponse } from "next/server";
import { authenticateBearer, unauthorizedHeaders, type Credential } from "@/lib/api-auth";
import { clientIp, recordAudit, requestIdFrom, type AuditEvent } from "@/lib/audit";
import { checkRateLimit, withRateLimit } from "@/lib/guard";
import { rateLimitHeaders } from "@/lib/ratelimit";
import { readTextCapped } from "@/lib/http/body";
import { beginIdempotent, finishIdempotent, hashRequest, releaseIdempotent, validIdempotencyKey } from "@/lib/idempotency";
import { ServiceError, type ServiceContext, type ServiceErrorCode } from "@/lib/service";
import { isMcpRequest } from "./mcp-marker";

/**
 * Shared plumbing for `/api/v1` (#37): bearer auth only (a cookie is never
 * read), one error shape, X-Request-Id on every response, rate limiting.
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 */

export const API_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid",
  "revision_conflict",
  "opaque_overlap",
  "unsupported",
  "rate_limited",
  "google_quota",
  "upstream_error",
  "unavailable",
  "payload_too_large",
  "idempotency_mismatch",
  "in_progress",
  "suggestions_pending",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  invalid: 400,
  revision_conflict: 409,
  opaque_overlap: 409,
  unsupported: 501,
  rate_limited: 429,
  google_quota: 429,
  upstream_error: 502,
  unavailable: 503,
  payload_too_large: 413,
  idempotency_mismatch: 422,
  in_progress: 409,
  suggestions_pending: 409,
};

const FROM_SERVICE: Record<ServiceErrorCode, ApiErrorCode> = {
  unauthenticated: "unauthenticated",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "revision_conflict",
  invalid: "invalid",
  unsupported: "unsupported",
  rate_limited: "rate_limited",
  upstream_quota: "google_quota",
  upstream_error: "upstream_error",
  suggestions_pending: "suggestions_pending",
};

export function apiCodeFor(code: ServiceErrorCode): ApiErrorCode {
  return FROM_SERVICE[code];
}

export function apiError(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  details: unknown = null,
  headers: Record<string, string> = {},
): NextResponse {
  return NextResponse.json(
    { error: { code, message, details, requestId } },
    { status: STATUS[code], headers: { "X-Request-Id": requestId, ...headers } },
  );
}

const IDEMPOTENT_BODY_MAX = 600 * 1024;

/** Fields a handler adds to the audit event the wrapper records for its call. */
export type AuditNote = Pick<AuditEvent, "fileId" | "baseRevisionId" | "resultRevisionId" | "ops" | "siteId" | "pagePath" | "importId" | "docAuthor" | "changeCount">;

export type V1Handler = (ctx: ServiceContext, request: Request, note: AuditNote, credential: Credential) => Promise<NextResponse | Response | object>;

/**
 * Runs a handler as an authenticated, rate-limited `/api/v1` call. ServiceError
 * becomes the API error shape; anything else is a 500 that leaks no detail.
 */
export async function v1(
  request: Request,
  bucket: string,
  perMinute: number,
  handler: V1Handler,
  options: {
    idempotent?: boolean;
    /** Record this event for the call: ok when the handler returns, denied or error when it fails. */
    audit?: AuditEvent["event"];
  } = {},
): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  const auth = await authenticateBearer(request);
  if (!auth.ok) {
    return apiError(requestId, auth.code === "unavailable" ? "unavailable" : "unauthenticated", auth.error, null, auth.status === 401 ? unauthorizedHeaders : {});
  }
  const limit = await checkRateLimit(bucket, `key:${auth.credential.id}`, perMinute, "api");
  if (!limit.ok) {
    // One line per refusal, so 429s by credential can be counted from the logs (#39).
    console.warn(JSON.stringify({ level: "warn", type: "rate_limited", bucket, credential: auth.credential.id, requestId }));
    return apiError(requestId, "rate_limited", "Too many requests.", null, rateLimitHeaders(limit));
  }
  const ctx: ServiceContext = { ...auth.ctx, requestId };
  // Calls made by the MCP server are audited as `mcp`, whatever the credential kind.
  if (isMcpRequest(request)) ctx.actor = { ...ctx.actor, client: "mcp" };

  // Mutating calls need an Idempotency-Key: a retried commit or publish runs once (#38).
  let claim: { credentialId: string; key: string } | null = null;
  if (options.idempotent) {
    const key = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!key) return apiError(requestId, "invalid", "The Idempotency-Key header is required on this call.");
    if (!validIdempotencyKey(key)) return apiError(requestId, "invalid", "Idempotency-Key must be 1 to 255 letters, digits, and _ . : -");
    ctx.idempotencyKey = key;
    const read = await readTextCapped(request.clone(), IDEMPOTENT_BODY_MAX);
    if (!read.ok) return apiError(requestId, "payload_too_large", "Request body is too large.");
    const hash = hashRequest(request.method, new URL(request.url).pathname, read.text);
    let begun;
    try {
      begun = await beginIdempotent(auth.credential.id, key, hash);
    } catch (error) {
      console.error("idempotency store failed", requestId, error instanceof Error ? error.name : "unknown");
      return apiError(requestId, "unavailable", "Idempotency could not be checked. Retry shortly.", null, { "Retry-After": "2" });
    }
    if (begun.state === "mismatch") return apiError(requestId, "idempotency_mismatch", "This Idempotency-Key was already used with a different request.");
    if (begun.state === "in_progress") return apiError(requestId, "in_progress", "A request with this Idempotency-Key is still running.", null, { "Retry-After": "1" });
    if (begun.state === "replay") {
      return withRateLimit(
        new NextResponse(begun.response.body, {
          status: begun.response.status,
          headers: { "Content-Type": "application/json", "X-Request-Id": requestId, "Idempotent-Replayed": "true" },
        }),
        limit,
      );
    }
    claim = { credentialId: auth.credential.id, key };
  }

  let response: NextResponse;
  const note: AuditNote = {};
  let outcome: "ok" | "denied" | "error" = "ok";
  let failure: string | null = null;
  try {
    const result = await handler(ctx, request, note, auth.credential);
    response = result instanceof Response ? (result as NextResponse) : NextResponse.json(result);
  } catch (error) {
    if (error instanceof ServiceError) {
      const retryAfter = error.retryAfterSeconds;
      outcome = error.code === "forbidden" || error.code === "conflict" ? "denied" : "error";
      failure = apiCodeFor(error.code);
      response = apiError(
        requestId,
        apiCodeFor(error.code),
        error.message,
        error.page ? { revisionId: error.page.revisionId } : retryAfter ? { retryAfterSeconds: retryAfter } : null,
        retryAfter ? { "Retry-After": String(retryAfter), ...rateLimitHeaders(limit) } : {},
      );
    } else {
      console.error("v1 handler failed", requestId, error instanceof Error ? error.name : "unknown");
      outcome = "error";
      failure = "upstream_error";
      response = apiError(requestId, "upstream_error", "The request could not be completed.");
    }
  }
  if (options.audit) {
    await recordAudit({
      ...note,
      event: options.audit,
      outcome,
      status: response.status,
      errorCode: failure,
      requestId,
      idempotencyKey: ctx.idempotencyKey ?? null,
      actorSub: ctx.actor.sub,
      actorKey: `${auth.credential.kind}:${auth.credential.id}`,
      client: ctx.actor.client,
      ip: clientIp(request),
    });
  }
  if (claim) {
    try {
      await finishIdempotent(claim.credentialId, claim.key, { status: response.status, body: await response.clone().text() });
    } catch {
      // The work is done; a failed record only means a retry may run it again.
      await releaseIdempotent(claim.credentialId, claim.key).catch(() => undefined);
    }
  }
  response.headers.set("X-Request-Id", requestId);
  return withRateLimit(response, limit);
}

/** Reads a capped JSON body; throws ServiceError("invalid") when it is not JSON. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const read = await readTextCapped(request, maxBytes);
  if (!read.ok) throw new ServiceError("invalid", "Request body is too large.");
  try {
    return read.text ? JSON.parse(read.text) : {};
  } catch {
    throw new ServiceError("invalid", "Request body is not valid JSON.");
  }
}
