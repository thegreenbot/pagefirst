import Link from "next/link";
import { redirect } from "next/navigation";
import { databaseConfigured } from "@/lib/db/client";
import { getSessionSub } from "@/lib/session";
import { createOrganization, listMemberships } from "@/lib/tenant/orgs";

export const dynamic = "force-dynamic";

async function createOrgAction(formData: FormData) {
  "use server";
  const sub = await getSessionSub();
  if (!sub) redirect("/api/auth/google");
  const name = formData.get("name");
  try {
    const org = await createOrganization(sub, typeof name === "string" ? name : "");
    redirect(`/orgs/${org.id}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("An organization needs")) redirect(`/orgs?error=${encodeURIComponent(error.message)}`);
    throw error;
  }
}

export default async function Orgs({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const query = await searchParams;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  const sub = databaseConfigured() ? await getSessionSub() : null;
  const memberships = sub ? await listMemberships(sub) : [];

  return (
    <main className="mx-auto max-w-3xl px-5 py-14">
      <Link href="/" className="text-sm text-ink-soft hover:text-ink">← Pages</Link>
      <h1 className="mt-4 font-serif text-4xl tracking-tight text-ink">Organizations</h1>
      {!sub ? (
        <p className="mt-6 text-ink-soft">
          <a href="/api/auth/google" className="text-green underline underline-offset-2">Connect Google</a> to see your organizations.
        </p>
      ) : (
        <>
          <ul className="mt-8 divide-y divide-rule border-y border-rule">
            {memberships.map(({ org, role, siteIds }) => (
              <li key={org.id} className="flex items-center justify-between gap-4 py-4">
                <div>
                  <p className="font-serif text-lg text-ink">{org.name}</p>
                  <p className="text-sm text-ink-soft">{role} · {org.plan} · {siteIds.length} {siteIds.length === 1 ? "site" : "sites"}</p>
                </div>
                {role === "owner" || role === "admin" ? (
                  <Link href={`/orgs/${org.id}`} className="text-sm text-green underline underline-offset-2">Members</Link>
                ) : null}
              </li>
            ))}
          </ul>
          <form action={createOrgAction} className="mt-10 flex flex-wrap items-end gap-3">
            <label className="text-sm text-ink-soft">
              New organization
              <input name="name" required maxLength={80} className="mt-1 block w-72 border border-rule bg-paper px-3 py-2 text-ink" />
            </label>
            <button type="submit" className="border border-ink px-4 py-2 text-sm text-ink hover:bg-ink hover:text-paper">Create</button>
          </form>
          {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}
        </>
      )}
    </main>
  );
}
