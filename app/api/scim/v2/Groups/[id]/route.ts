import { scim, readBody } from "@/enterprise/scim/http";
import { deleteGroup, getGroup, patchGroup, replaceGroup } from "@/enterprise/scim/groups";

export const dynamic = "force-dynamic";
type Params = { params: Promise<{ id: string }> };

export function GET(request: Request, { params }: Params) {
  return scim(request, "groups.get", async ({ orgId }) => ({ body: await getGroup(orgId, (await params).id) }));
}

export function PUT(request: Request, { params }: Params) {
  return scim(request, "groups.replace", async ({ orgId }) => ({ body: await replaceGroup(orgId, (await params).id, await readBody(request)) }));
}

export function PATCH(request: Request, { params }: Params) {
  return scim(request, "groups.patch", async ({ orgId }) => ({ body: await patchGroup(orgId, (await params).id, await readBody(request)) }));
}

export function DELETE(request: Request, { params }: Params) {
  return scim(request, "groups.delete", async ({ orgId }) => {
    await deleteGroup(orgId, (await params).id);
    return { status: 204, body: null };
  });
}
