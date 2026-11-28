import { protectedResourceMetadata } from "@/lib/oauth/protocol";
import { issuer, json, preflight } from "@/lib/oauth/http";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** RFC 9728 metadata for the MCP endpoint: its own resource URL, the same authorization server. */
export async function GET() {
  const origin = await issuer();
  return json({ ...protectedResourceMetadata(origin), resource: `${origin}/api/mcp`, resource_name: "Pagefirst MCP server" });
}
