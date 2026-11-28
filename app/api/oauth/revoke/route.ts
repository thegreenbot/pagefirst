import { databaseConfigured } from "@/lib/db/client";
import { json, NO_STORE, oauthError, preflight, readForm } from "@/lib/oauth/http";
import { revokeToken } from "@/lib/oauth/store";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** RFC 7009. Answers 200 whether or not the token existed. */
export async function POST(request: Request) {
  if (!databaseConfigured()) return oauthError("invalid_request", "OAuth is not available on this instance.", 503);
  const form = await readForm(request);
  const token = form?.get("token");
  const clientId = form?.get("client_id");
  if (!token || !clientId) return oauthError("invalid_request", "token and client_id are required.");
  await revokeToken(clientId, token);
  return json({}, 200, NO_STORE);
}
