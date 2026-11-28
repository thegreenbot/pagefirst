import { protectedResourceMetadata } from "@/lib/oauth/protocol";
import { issuer, json, preflight } from "@/lib/oauth/http";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** RFC 9728 metadata: which authorization server protects the API. */
export async function GET() {
  return json(protectedResourceMetadata(await issuer()));
}
