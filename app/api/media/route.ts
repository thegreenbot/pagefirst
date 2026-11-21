import { NextResponse } from "next/server";
import { saveMedia } from "@/lib/media";

export const dynamic = "force-dynamic";

const ALLOWED_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const mime = (file.type || "application/octet-stream").split(";")[0]?.trim().toLowerCase();
  if (!mime || !ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: "Unsupported image type" }, { status: 415 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const { id } = saveMedia(bytes, mime);
    return NextResponse.json({ id, driveFileId: id });
  } catch (error) {
    if (error instanceof Error && error.message === "Image is too large") {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    throw error;
  }
}
