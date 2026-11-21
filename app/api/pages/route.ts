import { NextResponse } from "next/server";
import { listPages } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const library = await listPages();
    return NextResponse.json(library);
  } catch (error) {
    const message =
      (error instanceof Error ? error.message : typeof error === "string" ? error : "") ||
      "Could not list pages.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
