"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auditAction } from "@/lib/audit-request";
import type { AuditEventName } from "@/lib/audit";
import { getSessionSub } from "@/lib/session";
import { cancelInvite, changeMemberRole, inviteMember, isPersonalOrg, MemberError, removeOrgMember } from "@/lib/tenant/members";
import { seatsChanged } from "@/lib/tenant/member-route";
import { closeOrganization } from "@/lib/tenant/offboard";
import { getOrganization, roleOf } from "@/lib/tenant/orgs";

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

/** Closes the organization after the owner repeats its name. Owners only, never a personal organization. */
export async function deleteOrgAction(orgId: string, data: FormData) {
  const sub = await getSessionSub();
  if (!sub) redirect("/api/auth/google");
  if ((await roleOf(orgId, sub)) !== "owner") redirect("/orgs");
  const org = await getOrganization(orgId);
  if (!org || (await isPersonalOrg(orgId))) redirect("/orgs");
  if (text(data, "confirm") !== org.name) redirect(`/orgs/${orgId}?error=${encodeURIComponent("Type the organization's name to delete it.")}`);
  try {
    await closeOrganization(orgId);
  } catch {
    await auditAction({ event: "org.deleted", outcome: "error", actorSub: sub, status: 502 });
    redirect(`/orgs/${orgId}?error=${encodeURIComponent("Could not remove the published files. Nothing was deleted; try again.")}`);
  }
  await auditAction({ event: "org.deleted", outcome: "ok", actorSub: sub });
  revalidatePath("/orgs");
  redirect("/orgs");
}
