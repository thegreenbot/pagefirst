/** An RFC 7644 error: HTTP status, optional scimType, and a detail safe to show the identity provider. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: "invalidFilter" | "tooMany" | "uniqueness" | "mutability" | "invalidSyntax" | "invalidPath" | "noTarget" | "invalidValue" | "invalidVers" | "sensitive",
  ) {
    super(detail);
    this.name = "ScimError";
  }
}

export const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
export const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";

export function errorBody(error: ScimError): object {
  return { schemas: [ERROR_SCHEMA], status: String(error.status), ...(error.scimType ? { scimType: error.scimType } : {}), detail: error.detail };
}
