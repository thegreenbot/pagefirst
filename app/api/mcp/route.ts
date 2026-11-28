import { NextResponse } from "next/server";
import { authenticateBearer, bearerToken } from "@/lib/api-auth";
import { requestIdFrom } from "@/lib/audit";
import { checkRateLimit, withRateLimit } from "@/lib/guard";
import { rateLimitHeaders } from "@/lib/ratelimit";
import { readTextCapped } from "@/lib/http/body";
import { CORS, issuer } from "@/lib/oauth/http";
import { handleMessage, parseError, SUPPORTED_VERSIONS, type RpcResponse } from "@/lib/mcp/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY = 2 * 1024 * 1024;
const MAX_BATCH = 20;

const headers = (extra: Record<string, string> = {}) => ({ ...CORS, "Access-Control-Expose-Headers": "WWW-Authenticate, X-Request-Id, RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset", ...extra });

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: headers() });
}

/** The server pushes nothing, so there is no stream to open. */
export function GET() {
  return new NextResponse(null, { status: 405, headers: headers({ Allow: "POST, OPTIONS" }) });
}

export const DELETE = GET;

/**
 * MCP over streamable HTTP, stateless (#41). Authentication is the same bearer
 * API key or OAuth access token as `/api/v1`; a missing or bad one gets the
 * 401 and `resource_metadata` pointer the MCP authorization spec asks for.
 */
export async function POST(request: Request) {
  const requestId = requestIdFrom(request);
  const origin = await issuer();
  const bearer = bearerToken(request);
  const auth = await authenticateBearer(request);
  if (!auth.ok || !bearer) {
    const status = auth.ok ? 401 : auth.status;
    const challenge = `Bearer realm="pagefirst", resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`;
    return NextResponse.json(
      { error: { code: auth.ok ? "unauthenticated" : auth.code, message: auth.ok ? "Send a bearer token." : auth.error, details: null, requestId } },
      { status, headers: headers({ "X-Request-Id": requestId, ...(status === 401 ? { "WWW-Authenticate": challenge } : {}) }) },
    );
  }
  const limit = await checkRateLimit("mcp", `key:${auth.credential.id}`, 300, "api");
  if (!limit.ok) {
    return NextResponse.json({ error: { code: "rate_limited", message: "Too many requests.", details: null, requestId } }, { status: 429, headers: headers({ "X-Request-Id": requestId, ...rateLimitHeaders(limit) }) });
  }

  const read = await readTextCapped(request, MAX_BODY);
  if (!read.ok) return NextResponse.json(parseError(), { status: 413, headers: headers({ "X-Request-Id": requestId }) });
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return withRateLimit(NextResponse.json(parseError(), { status: 400, headers: headers({ "X-Request-Id": requestId }) }), limit);
  }

  const asked = request.headers.get("mcp-protocol-version");
  if (asked && !(SUPPORTED_VERSIONS as readonly string[]).includes(asked)) {
    return withRateLimit(NextResponse.json({ error: { code: "invalid", message: `Unsupported MCP-Protocol-Version. Supported: ${SUPPORTED_VERSIONS.join(", ")}.`, details: null, requestId } }, { status: 400, headers: headers({ "X-Request-Id": requestId }) }), limit);
  }
  const caller = { scopes: auth.ctx.scopes, origin, bearer, requestId, protocolVersion: asked };

  const batch = Array.isArray(body);
  const messages: unknown[] = batch ? (body as unknown[]) : [body];
  if (messages.length === 0 || messages.length > MAX_BATCH) {
    return withRateLimit(NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `A batch holds 1 to ${MAX_BATCH} messages.` } }, { status: 400, headers: headers({ "X-Request-Id": requestId }) }), limit);
  }
  const replies: RpcResponse[] = [];
  for (const message of messages) {
    const reply = await handleMessage(message, caller);
    if (reply) replies.push(reply);
  }
  // Only notifications or responses in: acknowledge with no body.
  if (replies.length === 0) return withRateLimit(new NextResponse(null, { status: 202, headers: headers({ "X-Request-Id": requestId }) }), limit);
  return withRateLimit(NextResponse.json(batch ? replies : replies[0], { headers: headers({ "X-Request-Id": requestId }) }), limit);
}
