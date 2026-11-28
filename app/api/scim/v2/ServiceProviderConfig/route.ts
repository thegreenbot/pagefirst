import { scim } from "@/enterprise/scim/http";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return scim(request, "config", async () => ({
    body: {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", name: "Bearer token", description: "A SCIM token created by an organization owner or admin.", primary: true }],
    },
  }));
}
