import { scim, readBody } from "@/enterprise/scim/http";
import { createGroup, listGroups } from "@/enterprise/scim/groups";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return scim(request, "groups.list", async ({ orgId }) => ({ body: await listGroups(orgId, new URL(request.url).searchParams) }));
}

export function POST(request: Request) {
  return scim(request, "groups.create", async ({ orgId }) => ({ status: 201, body: await createGroup(orgId, await readBody(request)) }));
}
