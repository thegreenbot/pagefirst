import { API_ERROR_CODES } from "./v1";
import { SCOPES } from "@/lib/service/context";

/**
 * The OpenAPI 3.1 contract for `/api/v1` (#37). A test compares its paths and
 * methods with the route files, so a handler can't ship without a spec entry.
 */

const error = { $ref: "#/components/responses/Error" };
const secured = [{ bearer: [] }];
const idempotencyKey = { name: "Idempotency-Key", in: "header", required: true, description: "1 to 255 characters of letters, digits and _ . : -. A retry with the same key and body returns the first response (Idempotent-Replayed: true); the same key with a different body is idempotency_mismatch (422); the same key while the first call runs is in_progress (409). Keys last 24 hours per credential.", schema: { type: "string", maxLength: 255 } };
const fileId = { name: "fileId", in: "path", required: true, schema: { type: "string" } };

export const openapi = {
  openapi: "3.1.0",
  info: { title: "Pagefirst API", version: "1.0.0", description: "Create, edit and publish pages. Bearer credentials only; cookies are never accepted. Each operation has its own per-credential budget a minute (reads 120, create 20, commit 60, publish 6). Every response carries RateLimit-Limit, RateLimit-Remaining and RateLimit-Reset; a 429 adds Retry-After. Google quota is separate: calls to Google are paced per account, and when the wait would be too long the call fails with google_quota, Retry-After set and nothing sent to Google." },
  servers: [{ url: "/api/v1" }],
  security: secured,
  paths: {
    "/me": {
      get: { operationId: "getMe", summary: "The calling credential and its scopes", responses: { "200": { description: "OK" }, default: error } },
    },
    "/openapi.json": {
      get: { operationId: "getOpenApi", summary: "This document", security: [], responses: { "200": { description: "OK" } } },
    },
    "/content-audit": {
      get: {
        operationId: "getContentAudit",
        summary: "Report stale, expired, thin and near-duplicate pages",
        parameters: [
          { name: "staleDays", in: "query", schema: { type: "integer", minimum: 1, maximum: 3650, default: 365 } },
          { name: "thinWords", in: "query", schema: { type: "integer", minimum: 1, maximum: 5000, default: 120 } },
          { name: "duplicateThreshold", in: "query", schema: { type: "number", minimum: 0.3, maximum: 1, default: 0.8 } },
        ],
        responses: { "200": { description: "The report; truncated is true when more pages exist than were checked" }, default: error },
      },
    },
    "/content-audit/decisions": {
      get: {
        operationId: "listAuditDecisions",
        summary: "A page's audit decision history, newest first",
        parameters: [{ name: "fileId", in: "query", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "OK" }, default: error },
      },
      post: {
        operationId: "recordAuditDecision",
        summary: "Record what was decided about a flagged page",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["fileId", "finding", "decision"], properties: { fileId: { type: "string" }, finding: { type: "string", enum: ["stale", "expired", "thin", "duplicate"] }, decision: { type: "string", enum: ["keep", "update", "merge", "rewrite", "noindex", "remove"] }, note: { type: "string", maxLength: 1000 } } } } } },
        responses: { "201": { description: "Recorded" }, default: error },
      },
    },
    "/pages": {
      get: {
        operationId: "listPages",
        summary: "List pages in the credential's site folders",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "A page of results with nextCursor" }, default: error },
      },
      post: {
        operationId: "createPage",
        summary: "Create a page from the template Doc",
        parameters: [idempotencyKey],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string", maxLength: 200 } } } } } },
        responses: { "201": { description: "Created" }, default: error },
      },
    },
    "/pages/{fileId}": {
      get: { operationId: "getPage", summary: "The parsed page and its revisionId", parameters: [fileId], responses: { "200": { description: "OK" }, default: error } },
    },
    "/pages/{fileId}/commits": {
      post: {
        operationId: "commitPage",
        summary: "Apply ops against a base revision",
        parameters: [fileId, idempotencyKey],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["baseRevisionId", "ops"], properties: { baseRevisionId: { type: "string" }, ops: { type: "array", items: { type: "object" } } } } } } },
        responses: { "200": { description: "Committed" }, "409": { description: "revision_conflict, or in_progress for a duplicate key still running" }, "422": { description: "idempotency_mismatch" }, default: error },
      },
    },
    "/pages/{fileId}/publishes": {
      post: {
        operationId: "publishPage",
        summary: "Publish a pinned revision",
        parameters: [fileId, idempotencyKey],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["revisionId"], properties: { revisionId: { type: "string" }, public: { type: "boolean" } } } } } },
        responses: { "200": { description: "Published" }, default: error },
      },
    },
  },
  components: {
    securitySchemes: { bearer: { type: "http", scheme: "bearer", description: `API key (pf_live_...) or OAuth access token. Scopes: ${SCOPES.join(", ")}.` } },
    headers: {
      "RateLimit-Limit": { description: "Calls allowed a minute for this operation.", schema: { type: "integer" } },
      "RateLimit-Remaining": { description: "Calls left in the current window.", schema: { type: "integer" } },
      "RateLimit-Reset": { description: "Seconds until the window frees a slot.", schema: { type: "integer" } },
      "Retry-After": { description: "On a 429 (rate_limited or google_quota): seconds to wait before retrying.", schema: { type: "integer" } },
    },
    responses: {
      Error: {
        description: "Every failure has this shape; X-Request-Id is on every response.",
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["error"],
              properties: {
                error: {
                  type: "object",
                  required: ["code", "message", "details", "requestId"],
                  properties: { code: { type: "string", enum: [...API_ERROR_CODES] }, message: { type: "string" }, details: {}, requestId: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
