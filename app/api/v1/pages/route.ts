import { NextResponse } from "next/server";
import { v1, readJson } from "@/lib/api/v1";
import { createPage, listPages, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** Pages in the credential's site folders, with cursor pagination. */
export function GET(request: Request) {
  return v1(request, "v1-pages-list", 120, async (ctx) => {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    const offset = /^\d{1,6}$/.test(url.searchParams.get("cursor") ?? "") ? Number(url.searchParams.get("cursor")) : 0;
    const { pages } = await listPages(ctx);
    const slice = pages.slice(offset, offset + limit);
    return { pages: slice, nextCursor: offset + limit < pages.length ? String(offset + limit) : null };
  });
}

/** Creates a page from the template Doc. */
export function POST(request: Request) {
  return v1(request, "v1-pages-create", 20, async (ctx, _request, note) => {
    const body = (await readJson(request, 4096)) as { title?: unknown };
    if (typeof body?.title !== "string" || !body.title.trim() || body.title.length > 200) {
      throw new ServiceError("invalid", "title must be text of 1 to 200 characters.");
    }
    const created = await createPage(ctx, body.title.trim());
    note.fileId = created.page.fileId;
    note.pagePath = created.page.path;
    return NextResponse.json(created, { status: 201 });
  }, { audit: "page.create" });
}
