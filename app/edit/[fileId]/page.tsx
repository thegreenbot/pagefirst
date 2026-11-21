import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { isSafeId } from "@/lib/page/types";
import { getPage } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function EditPage({
  params,
}: {
  params: Promise<{ fileId: string }>;
}) {
  const { fileId } = await params;
  if (!isSafeId(fileId)) notFound();
  const payload = await getPage(fileId);
  if (!payload) notFound();
  return (
    <PageEditor
      key={payload.page.fileId}
      initial={payload.page}
      sample={payload.sample}
    />
  );
}
