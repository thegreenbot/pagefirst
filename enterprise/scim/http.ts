import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { requestIdFrom } from "@/lib/audit";
import { checkRateLimit } from "@/lib/guard";
import { databaseConfigured } from "@/lib/db/client";
import { readTextCapped } from "@/lib/http/body";
import { rateLimitHeaders } from "@/lib/ratelimit";
import { PlanError } from "@/lib/tenant/plans";
import { requireOrgFeature } from "@/lib/tenant/orgs";
import { errorBody, ScimError } from "./errors";
import { verifyScimToken } from "./tokens";

const CONTENT_TYPE = "application/scim+json";

export type ScimContext = { orgId: string; tokenId: string; request: Request };

function respond(body: object | null, status: number, headers: Record<string, string> = {}): NextResponse {
  if (body === null) return new NextResponse(null, { status, headers });
  return new NextResponse(JSON.stringify(body), { status, headers: { "Content-Type": CONTENT_TYPE, ...headers } });
}

/** Reads a capped JSON body. SCIM clients send `application/scim+json` or `application/json`. */
export async function readBody(request: Request): Promise<unknown> {
  const read = await readTextCapped(request, 256 * 1024);
  if (!read.ok) throw new ScimError(413, "Request body is too large.", "invalidSyntax");
  try {
    return read.text ? JSON.parse(read.text) : {};
  } catch {
    throw new ScimError(400, "Request body is not valid JSON.", "invalidSyntax");
  }
}

/**
 * Runs a SCIM handler as an authenticated, plan-checked, rate-limited call for
 * the organization the bearer token belongs to. Cookies are never read.
 */
export async function scim(
  request: Request,
  action: string,
  handler: (ctx: ScimContext) => Promise<{ status?: number; body?: object | null }>,
): Promise<NextResponse> {
  const requestId = requestIdFrom(request);
  const headers = { "X-Request-Id": requestId };
  try {
    if (!databaseConfigured()) throw new ScimError(503, "SCIM needs the database.");
    const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    const auth = bearer ? await verifyScimToken(bearer) : null;
    if (!auth) return respond(errorBody(new ScimError(401, "Invalid or revoked SCIM token.")), 401, { ...headers, "WWW-Authenticate": 'Bearer realm="scim"' });
    const limit = await checkRateLimit(`scim-${request.method === "GET" ? "read" : "write"}`, `token:${auth.tokenId}`, request.method === "GET" ? 600 : 300, "api");
    if (!limit.ok) return respond(errorBody(new ScimError(429, "Too many requests.", "tooMany")), 429, { ...headers, ...rateLimitHeaders(limit) });
    await requireOrgFeature(auth.orgId, "scim");
    const result = await handler({ orgId: auth.orgId, tokenId: auth.tokenId, request });
    if (request.method !== "GET") {
      await auditRequest(request, { event: "scim.provision", outcome: "ok", status: result.status ?? 200, actorSub: null, actorKey: auth.tokenId, pagePath: `${auth.orgId}:${action}` });
    }
    return respond(result.body ?? null, result.status ?? 200, { ...headers, ...rateLimitHeaders(limit) });
  } catch (error) {
    if (error instanceof PlanError) return respond(errorBody(new ScimError(403, error.message)), 403, headers);
    if (error instanceof ScimError) return respond(errorBody(error), error.status, headers);
    console.error("scim handler failed", requestId, error instanceof Error ? error.name : "unknown");
    return respond(errorBody(new ScimError(500, "The request could not be completed.")), 500, headers);
  }
}
