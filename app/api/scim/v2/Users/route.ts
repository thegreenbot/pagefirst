import { scim, readBody } from "@/enterprise/scim/http";
import { createUser, listUsers, userResource } from "@/enterprise/scim/users";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return scim(request, "users.list", async ({ orgId }) => ({ body: await listUsers(orgId, new URL(request.url).searchParams) }));
}

export function POST(request: Request) {
  return scim(request, "users.create", async ({ orgId }) => ({ status: 201, body: userResource(await createUser(orgId, await readBody(request))) }));
}
