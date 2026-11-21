import { NextResponse } from "next/server";
import { sameOrigin } from "@/lib/guard";
import { getAccessToken } from "@/lib/session";
import { spikeEnabled } from "@/lib/spike/drive-probe";

export const dynamic = "force-dynamic";

/**
 * Spike only: Google Picker runs in the browser and needs the OAuth token.
 * Product code keeps the token in the httpOnly cookie; this route exists only
 * behind PAGEFIRST_SPIKE=1, refuses cross-origin calls, and is never cached.
 */
export async function GET(request: Request) {
  if (!spikeEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin" }, { status: 403 });
  const token = await getAccessToken();
  if (!token) return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
  return NextResponse.json(
    {
      token,
      apiKey: process.env.SPIKE_PICKER_API_KEY ?? "",
      appId: process.env.SPIKE_PICKER_APP_ID ?? "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
