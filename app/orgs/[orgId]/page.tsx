import Link from "next/link";
import { notFound } from "next/navigation";
import { databaseConfigured } from "@/lib/db/client";
import { getSessionSub } from "@/lib/session";
import { isPersonalOrg, listOrgMembers } from "@/lib/tenant/members";
import { getOrganization, ROLES, roleOf } from "@/lib/tenant/orgs";
import { cancelInviteAction, inviteAction, removeAction, roleAction } from "./actions";

export const dynamic = "force-dynamic";

const field = "border border-rule bg-paper px-2 py-1 text-ink";
const button = "border border-ink px-3 py-1 text-sm text-ink hover:bg-ink hover:text-paper";

export default async function Members({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ error?: string | string[] }> }) {
  const { orgId } = await params;
  const query = await searchParams;
  const error = Array.isArray(query.error) ? query.error[0] : query.error;
  if (!databaseConfigured()) notFound();
  const sub = await getSessionSub();
  if (!sub) notFound();
  const role = await roleOf(orgId, sub);
  if (role !== "owner" && role !== "admin") notFound();
  const org = await getOrganization(orgId);
  if (!org) notFound();
  const [{ members, pending }, personal] = await Promise.all([listOrgMembers(orgId), isPersonalOrg(orgId)]);
  const grantable = ROLES.filter((r) => role === "owner" || r !== "owner");

  return (
    <main className="mx-auto max-w-3xl px-5 py-14">
      <Link href="/orgs" className="text-sm text-ink-soft hover:text-ink">← Organizations</Link>
      <h1 className="mt-4 font-serif text-4xl tracking-tight text-ink">{org.name}</h1>
      <p className="mt-2 text-sm text-ink-soft">{members.length} {members.length === 1 ? "member" : "members"} · {org.plan} plan</p>
      {error ? <p role="alert" className="mt-4 text-sm text-red-700">{error}</p> : null}

      <ul className="mt-8 divide-y divide-rule border-y border-rule">
        {members.map((m) => (
          <li key={m.sub} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-ink">{m.email ?? m.sub}{m.sub === sub ? " (you)" : ""}</span>
            <span className="flex items-center gap-2">
              <form action={roleAction.bind(null, orgId, m.sub)} className="flex items-center gap-2">
                <select name="role" defaultValue={m.role} className={field} aria-label={`Role for ${m.email ?? m.sub}`}>
                  {grantable.concat(m.role === "owner" && !grantable.includes("owner") ? ["owner"] : []).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
                <button type="submit" className={button}>Save</button>
              </form>
              <form action={removeAction.bind(null, orgId, m.sub)}>
                <button type="submit" className={button}>Remove</button>
              </form>
            </span>
          </li>
        ))}
      </ul>

      {pending.length > 0 ? (
        <>
          <h2 className="mt-10 font-serif text-xl text-ink">Pending invites</h2>
          <ul className="mt-3 divide-y divide-rule border-y border-rule">
            {pending.map((p) => (
              <li key={p.email} className="flex items-center justify-between gap-3 py-3">
                <span className="text-ink">{p.email} <span className="text-sm text-ink-soft">as {p.role}</span></span>
                <form action={cancelInviteAction.bind(null, orgId, p.email)}>
                  <button type="submit" className={button}>Cancel</button>
                </form>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {personal ? (
        <p className="mt-10 text-sm text-ink-soft">A personal organization belongs to one person. Create a separate organization to work with others.</p>
      ) : (
        <form action={inviteAction.bind(null, orgId)} className="mt-10 flex flex-wrap items-end gap-3">
          <label className="text-sm text-ink-soft">
            Invite by email
            <input name="email" type="email" required className={`${field} mt-1 block w-72`} />
          </label>
          <label className="text-sm text-ink-soft">
            Role
            <select name="role" defaultValue="editor" className={`${field} mt-1 block`}>
              {grantable.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <button type="submit" className={button}>Invite</button>
        </form>
      )}
    </main>
  );
}
