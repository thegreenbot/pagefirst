import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/lib/guard";
import { getAccessToken } from "@/lib/session";
import {
  createInDrive,
  docsWrite,
  isDriveId,
  runProbes,
  spikeEnabled,
} from "@/lib/spike/drive-probe";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

async function gate(): Promise<{ token: string } | NextResponse> {
  if (!spikeEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const token = await getAccessToken();
  if (!token) return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
  return { token };
}

export async function GET(request: NextRequest) {
  const gated = await gate();
  if (gated instanceof NextResponse) return gated;
  const root = request.nextUrl.searchParams.get("root") ?? "";
  const doc = request.nextUrl.searchParams.get("doc") ?? "";
  if ((root && !isDriveId(root)) || (doc && !isDriveId(doc))) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const results = await runProbes(gated.token, {
    rootId: root || undefined,
    docId: doc || undefined,
  });
  return NextResponse.json({ results }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const gated = await gate();
  if (gated instanceof NextResponse) return gated;
  if (!sameOrigin(request)) return NextResponse.json({ error: "Cross-origin" }, { status: 403 });

  let body: { action?: unknown; parentId?: unknown; docId?: unknown; name?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Bad JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" && body.name.length <= 100 ? body.name : "pagefirst-spike";
  const parentId = isDriveId(body.parentId) ? body.parentId : null;

  switch (body.action) {
    case "create-folder":
      return NextResponse.json({ results: [await createInDrive(gated.token, "folder", name, parentId)] }, { headers: NO_STORE });
    case "create-doc":
      return NextResponse.json({ results: [await createInDrive(gated.token, "doc", name, parentId)] }, { headers: NO_STORE });
    case "write":
      if (!isDriveId(body.docId)) return NextResponse.json({ error: "Invalid doc id" }, { status: 400 });
      return NextResponse.json({ results: [await docsWrite(gated.token, body.docId)] }, { headers: NO_STORE });
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
