"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auditAction } from "@/lib/audit-request";
import type { AuditEventName } from "@/lib/audit";
import { getSessionSub } from "@/lib/session";
import { cancelInvite, changeMemberRole, inviteMember, MemberError, removeOrgMember } from "@/lib/tenant/members";
import { seatsChanged } from "@/lib/tenant/member-route";
import { roleOf } from "@/lib/tenant/orgs";

const text = (data: FormData, key: string): string => {
  const value = data.get(key);
  return typeof value === "string" ? value : "";
};

/** Runs one membership change as the signed-in owner or admin. The role is looked up here, never taken from the form. */
async function run(orgId: string, event: AuditEventName, change: (actor: NonNullable<Awaited<ReturnType<typeof roleOf>>>) => Promise<unknown>): Promise<never> {
  const sub = await getSessionSub();
  if (!sub) redirect("/api/auth/google");
  const actor = await roleOf(orgId, sub);
  if (actor !== "owner" && actor !== "admin") redirect("/orgs");
  let error = "";
  try {
    await change(actor);
    await seatsChanged(orgId);
    await auditAction({ event, outcome: "ok", actorSub: sub });
  } catch (caught) {
    if (!(caught instanceof MemberError)) throw caught;
    error = caught.message;
    await auditAction({ event, outcome: "denied", actorSub: sub, status: caught.status });
  }
  revalidatePath(`/orgs/${orgId}`);
  redirect(error ? `/orgs/${orgId}?error=${encodeURIComponent(error)}` : `/orgs/${orgId}`);
}

export async function inviteAction(orgId: string, data: FormData) {
  return run(orgId, "org.member.invited", (actor) => inviteMember(orgId, actor, text(data, "email"), text(data, "role")));
}
export async function roleAction(orgId: string, sub: string, data: FormData) {
  return run(orgId, "org.member.role_changed", (actor) => changeMemberRole(orgId, actor, sub, text(data, "role")));
}
export async function removeAction(orgId: string, sub: string) {
  return run(orgId, "org.member.removed", (actor) => removeOrgMember(orgId, actor, sub));
}
export async function cancelInviteAction(orgId: string, email: string) {
  return run(orgId, "org.invite.cancelled", (actor) => cancelInvite(orgId, actor, email));
}
