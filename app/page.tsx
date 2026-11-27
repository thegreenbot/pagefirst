import Link from "next/link";
import { redirect } from "next/navigation";
import { NewPageForm } from "@/components/new-page-form";
import type { Library } from "@/lib/page/types";
import { createPage, listPages } from "@/lib/store";
import { auditAction } from "@/lib/audit-request";

export const dynamic = "force-dynamic";

async function createPageAction(formData: FormData) {
  "use server";
  const value = formData.get("title");
  const trimmed = typeof value === "string" ? value.trim() : "";
  const title = trimmed || "Untitled";
  const created = await createPage(title);
  await auditAction({ event: "page.create", outcome: "ok", fileId: created.page.fileId, resultRevisionId: created.page.revisionId });
  redirect(`/edit/${created.page.fileId}`);
}

function messageOf(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message || "Could not load pages.";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ google?: string | string[] }>;
}) {
  const query = await searchParams;
  const google = Array.isArray(query.google) ? query.google[0] : query.google;
  const googleUnconfigured = google === "unconfigured";

  let library: Library | undefined;
  let loadError: string | undefined;
  try {
    library = await listPages();
  } catch (error) {
    loadError = messageOf(error);
  }

  const showSampleNote = library?.sample === true || googleUnconfigured;

  return (
    <>
      <header className="sticky top-0 z-10 border-b border-rule bg-paper/95">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <Link href="/" className="shrink-0 font-serif text-lg tracking-tight text-ink">
            Page-first
          </Link>
          <nav className="flex gap-4 text-sm text-ink-soft">
            <Link href="/" className="shrink-0 text-ink">
              Pages
            </Link>
            <Link href="/plan" className="shrink-0 hover:text-ink">
              Plan
            </Link>
            <Link href="/privacy" className="shrink-0 hover:text-ink">
              Privacy
            </Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24">
        <section className="border-b border-rule py-14">
          <h1 className="font-serif text-5xl tracking-tight text-ink">Pages</h1>
          <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink-soft">
            An author edits the preview. Commit writes the Google Doc. Publish
            uploads a static snapshot.
          </p>
          {showSampleNote ? (
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-ink-soft">
              These are sample pages.{" "}
              <a href="/api/auth/google" className="text-green underline underline-offset-2">
                Connect Google
              </a>{" "}
              to edit Docs you own.
            </p>
          ) : (
            <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
              <form action="/api/auth/logout" method="post">
                <button type="submit" className="text-sm text-green underline underline-offset-2">
                  Sign out of Google
                </button>
              </form>
              <form action="/api/auth/disconnect" method="post">
                <button type="submit" className="text-sm text-ink-soft underline underline-offset-2">
                  Sign out everywhere
                </button>
              </form>
            </div>
          )}
        </section>

        <section className="py-14">
          {loadError ? (
            <p
              role="alert"
              className="mb-8 border border-rule bg-paper-2 px-4 py-3 text-sm text-ink"
            >
              {loadError}
            </p>
          ) : null}

          {library && library.pages.length === 0 ? (
            <p className="text-ink-soft">No pages yet.</p>
          ) : null}

          {library && library.pages.length > 0 ? (
            <ul className="divide-y divide-rule border-y border-rule">
              {library.pages.map((page) => (
                <li key={page.fileId}>
                  <Link href={`/edit/${page.fileId}`} className="block py-4 text-ink">
                    <span className="block font-serif text-2xl tracking-tight">
                      {page.title}
                    </span>
                    <span className="mt-1 block text-sm text-ink-soft">
                      {page.path}
                      {page.changed ? <span className="ml-3 border border-rule bg-paper-2 px-2 py-0.5 text-xs text-ink">Changed in Google Doc</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}

          <NewPageForm action={createPageAction} />
        </section>
      </main>
    </>
  );
}
