import { NextResponse } from "next/server";
import { authenticateBearer, unauthorizedHeaders } from "@/lib/api-auth";
import { requestIdFrom } from "@/lib/audit";
import { checkRateLimit, withRateLimit } from "@/lib/guard";
import { rateLimitHeaders } from "@/lib/ratelimit";
import { readTextCapped } from "@/lib/http/body";
import { ServiceError, type ServiceContext, type ServiceErrorCode } from "@/lib/service";

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

export type V1Handler = (ctx: ServiceContext, request: Request) => Promise<NextResponse | Response | object>;

/**
 * Runs a handler as an authenticated, rate-limited `/api/v1` call. ServiceError
 * becomes the API error shape; anything else is a 500 that leaks no detail.
 */
export async function v1(request: Request, bucket: string, perMinute: number, handler: V1Handler): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  const auth = await authenticateBearer(request);
  if (!auth.ok) {
    return apiError(requestId, auth.code === "unavailable" ? "unavailable" : "unauthenticated", auth.error, null, auth.status === 401 ? unauthorizedHeaders : {});
  }
  const limit = await checkRateLimit(bucket, `key:${auth.credential.id}`, perMinute, "api");
  if (!limit.ok) {
    return apiError(requestId, "rate_limited", "Too many requests.", null, rateLimitHeaders(limit));
  }
  const ctx: ServiceContext = { ...auth.ctx, requestId };
  try {
    const result = await handler(ctx, request);
    const response = result instanceof Response ? (result as NextResponse) : NextResponse.json(result);
    response.headers.set("X-Request-Id", requestId);
    return withRateLimit(response, limit);
  } catch (error) {
    if (error instanceof ServiceError) {
      return apiError(requestId, apiCodeFor(error.code), error.message, error.page ? { revisionId: error.page.revisionId } : null);
    }
    console.error("v1 handler failed", requestId, error instanceof Error ? error.name : "unknown");
    return apiError(requestId, "upstream_error", "The request could not be completed.");
  }
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
