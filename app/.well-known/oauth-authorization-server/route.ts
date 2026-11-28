import { authorizationServerMetadata } from "@/lib/oauth/protocol";
import { issuer, json, preflight } from "@/lib/oauth/http";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** RFC 8414 metadata, so an MCP client can discover the endpoints. */
export async function GET() {
  return json(authorizationServerMetadata(await issuer()));
}
