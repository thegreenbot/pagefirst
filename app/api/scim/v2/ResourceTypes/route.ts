import { scim } from "@/enterprise/scim/http";
import { LIST_SCHEMA } from "@/enterprise/scim/errors";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return scim(request, "resource-types", async () => {
    const resources = [
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: "urn:ietf:params:scim:schemas:core:2.0:User" },
      { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: "urn:ietf:params:scim:schemas:core:2.0:Group" },
    ];
    return { body: { schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resources } };
  });
}
