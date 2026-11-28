import { scim, readBody } from "@/enterprise/scim/http";
import { deleteUser, getUserRow, patchUser, replaceUser, userResource } from "@/enterprise/scim/users";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export function GET(request: Request, { params }: Params) {
  return scim(request, "users.get", async ({ orgId }) => ({ body: userResource(await getUserRow(orgId, (await params).id)) }));
}

export function PUT(request: Request, { params }: Params) {
  return scim(request, "users.replace", async ({ orgId }) => ({ body: userResource(await replaceUser(orgId, (await params).id, await readBody(request))) }));
}

export function PATCH(request: Request, { params }: Params) {
  return scim(request, "users.patch", async ({ orgId }) => ({ body: userResource(await patchUser(orgId, (await params).id, await readBody(request))) }));
}

export function DELETE(request: Request, { params }: Params) {
  return scim(request, "users.delete", async ({ orgId }) => {
    await deleteUser(orgId, (await params).id);
    return { status: 204, body: null };
  });
}
