import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { PageEditor } from "@/components/editor/page-editor";
import { isSafeId } from "@/lib/page/types";
import { getPage } from "@/lib/store";
import { availableThemes, renderContextFor } from "@/lib/site/theme-config";
import { getSessionSub } from "@/lib/session";

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
  // The site's locked theme and stored presentation (#56); sample pages use the default theme.
  const sub = payload.sample ? null : await getSessionSub();
  const context = await renderContextFor(sub, fileId);
  const themes = context.config ? await availableThemes() : [];
  const drift = payload.changedInDoc;
  return (
    <>
      <PageEditor
        key={payload.page.fileId}
        initial={payload.page}
        sample={payload.sample}
        theme={context.theme}
        siteConfig={
          context.config
            ? {
                settings: context.config.settings,
                tokens: context.config.tokens,
              }
            : null
        }
        presentation={context.presentation}
        themes={themes}
        nonce={nonce}
        drift={drift ?? null}
      />
    </>
  );
}
