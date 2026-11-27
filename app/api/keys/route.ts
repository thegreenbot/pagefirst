import { NextResponse } from "next/server";
import { auditRequest } from "@/lib/audit-request";
import { createApiKey, KeyInputError, listApiKeys } from "@/lib/auth/api-keys";
import { readTextCapped } from "@/lib/http/body";
import { getSessionSub } from "@/lib/session";

export const dynamic = "force-dynamic";

async function owner(): Promise<string | NextResponse> {
  const sub = await getSessionSub();
  if (!sub) return NextResponse.json({ error: "Sign in with Google to manage API keys." }, { status: 401 });
  return sub;
}

/** The signed-in user's keys. Secrets are never returned here. */
export async function GET() {
  const sub = await owner();
  if (typeof sub !== "string") return sub;
  return NextResponse.json({ keys: await listApiKeys(sub) });
}

/** Creates a key. The response is the only time the secret is shown. */
export async function POST(request: Request) {
  const sub = await owner();
  if (typeof sub !== "string") return sub;
  const read = await readTextCapped(request, 8_000);
  if (!read.ok) return NextResponse.json({ error: "Request is too large" }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(read.text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  try {
    const { key, record } = await createApiKey(sub, body);
    await auditRequest(request, { event: "api_key.created", outcome: "ok", status: 201, actorKey: record.prefix });
    return NextResponse.json({ key, record }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof KeyInputError) {
      await auditRequest(request, { event: "api_key.created", outcome: "denied", status: 400, errorCode: "invalid_key_request" });
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
