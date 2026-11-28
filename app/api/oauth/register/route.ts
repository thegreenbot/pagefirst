import { callerKey, checkRateLimit } from "@/lib/guard";
import { databaseConfigured } from "@/lib/db/client";
import { readTextCapped } from "@/lib/http/body";
import { json, oauthError, preflight } from "@/lib/oauth/http";
import { parseRedirectUris } from "@/lib/oauth/protocol";
import { registerClient } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** RFC 7591 dynamic client registration, for public PKCE clients only. */
export async function POST(request: Request) {
  if (!databaseConfigured()) return oauthError("invalid_request", "OAuth is not available on this instance.", 503);
  const limit = await checkRateLimit("oauth-register", callerKey(null, request), 20, "mcp");
  if (!limit.ok) return oauthError("invalid_request", "Too many registrations. Try again later.", 429);

  const read = await readTextCapped(request, 8_000);
  if (!read.ok) return oauthError("invalid_request", "Request is too large.", 413);
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return oauthError("invalid_request", "Send a JSON object.");
  }
  if (typeof body !== "object" || body === null) return oauthError("invalid_request", "Send a JSON object.");
  const input = body as Record<string, unknown>;

  const redirectUris = parseRedirectUris(input.redirect_uris);
  if (!redirectUris) {
    return json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be 1 to 5 https URLs, or http on localhost." }, 400);
  }
  if (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none") {
    return json({ error: "invalid_client_metadata", error_description: "Only public clients (token_endpoint_auth_method none) are supported." }, 400);
  }
  const rawName = typeof input.client_name === "string" ? input.client_name.trim() : "";
  const name = rawName.slice(0, 80) || "MCP client";

  const client = await registerClient(name, redirectUris);
  return json(
    {
      client_id: client.clientId,
      client_name: client.name,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    201,
    { "Cache-Control": "no-store" },
  );
}
