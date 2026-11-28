import { callerKey, checkRateLimit } from "@/lib/guard";
import { databaseConfigured } from "@/lib/db/client";
import { auditRequest } from "@/lib/audit-request";
import { json, NO_STORE, oauthError, preflight, readForm } from "@/lib/oauth/http";
import { exchangeCode, getClient, refresh } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** Authorization-code (with PKCE) and refresh-token grants. */
export async function POST(request: Request) {
  if (!databaseConfigured()) return oauthError("invalid_request", "OAuth is not available on this instance.", 503);
  const limit = await checkRateLimit("oauth-token", callerKey(null, request), 60, "mcp");
  if (!limit.ok) return oauthError("invalid_request", "Too many requests.", 429);

  const form = await readForm(request);
  if (!form) return oauthError("invalid_request", "Request is too large.", 413);
  const clientId = form.get("client_id") ?? "";
  const client = await getClient(clientId);
  if (!client) return oauthError("invalid_client", "Unknown client.", 401);

  const grant = form.get("grant_type");
  let result;
  if (grant === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    if (!code || !verifier || !redirectUri) return oauthError("invalid_request", "code, code_verifier and redirect_uri are required.");
    result = await exchangeCode({ clientId, code, codeVerifier: verifier, redirectUri });
  } else if (grant === "refresh_token") {
    const token = form.get("refresh_token");
    if (!token) return oauthError("invalid_request", "refresh_token is required.");
    result = await refresh({ clientId, refreshToken: token });
  } else {
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }

  if (!result.ok) {
    await auditRequest(request, { event: "request.denied", outcome: "denied", status: 400, errorCode: `oauth:${grant}:invalid_grant`, actorSub: null });
    return oauthError("invalid_grant", "That grant is invalid, expired or already used.");
  }
  return json(result.tokens, 200, NO_STORE);
}
