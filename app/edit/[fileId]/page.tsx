import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { isSafeId } from "@/lib/page/types";
import { getPage } from "@/lib/store";
import { getDefaultTheme } from "@/lib/theme/package";

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
  // The preview frame inherits this page's CSP, so its bridge script needs this request's nonce.
  const nonce = (await headers()).get("x-nonce") ?? "";
  return (
    <PageEditor
      key={payload.page.fileId}
      initial={payload.page}
      sample={payload.sample}
      theme={getDefaultTheme()}
      nonce={nonce}
    />
  );
}
