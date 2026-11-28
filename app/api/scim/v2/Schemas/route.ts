import { scim } from "@/enterprise/scim/http";
import { LIST_SCHEMA } from "@/enterprise/scim/errors";

export const dynamic = "force-dynamic";

/** The attributes Pagefirst stores. Everything else a provider sends is accepted and ignored. */
export function GET(request: Request) {
  return scim(request, "schemas", async () => {
    const resources = [
      {
        id: "urn:ietf:params:scim:schemas:core:2.0:User",
        name: "User",
        description: "A person. userName is their Google account email; roles[0].value is owner, admin, editor or viewer.",
        attributes: ["userName", "externalId", "displayName", "name", "emails", "active", "roles"].map((name) => ({ name, type: name === "active" ? "boolean" : "string", multiValued: name === "emails" || name === "roles", required: name === "userName", mutability: "readWrite" })),
      },
      {
        id: "urn:ietf:params:scim:schemas:core:2.0:Group",
        name: "Group",
        description: "A role. displayName is owner, admin, editor or viewer (optionally prefixed pagefirst-); members get that role.",
        attributes: [{ name: "displayName", type: "string", multiValued: false, required: true, mutability: "readOnly" }, { name: "members", type: "complex", multiValued: true, required: false, mutability: "readWrite" }],
      },
    ];
    return { body: { schemas: [LIST_SCHEMA], totalResults: 2, startIndex: 1, itemsPerPage: 2, Resources: resources } };
  });
}
