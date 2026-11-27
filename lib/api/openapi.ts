import { API_ERROR_CODES } from "./v1";
import { SCOPES } from "@/lib/service/context";

/**
 * The OpenAPI 3.1 contract for `/api/v1` (#37). A test compares its paths and
 * methods with the route files, so a handler can't ship without a spec entry.
 */

const error = { $ref: "#/components/responses/Error" };
const secured = [{ bearer: [] }];
const idempotencyKey = { name: "Idempotency-Key", in: "header", required: true, description: "1 to 255 characters of letters, digits and _ . : -. A retry with the same key and body returns the first response (Idempotent-Replayed: true); the same key with a different body is idempotency_mismatch (422); the same key while the first call runs is in_progress (409). Keys last 24 hours per credential.", schema: { type: "string", maxLength: 255 } };
const jobId = { name: "id", in: "path", required: true, schema: { type: "string" } };
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
    "/audit": {
      get: {
        operationId: "listAudit",
        summary: "The caller's own audit events, newest first",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 50 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "Events with nextCursor" }, default: error },
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
    "/jobs": {
      post: {
        operationId: "createJob",
        summary: "Start a bulk job (commit, publish, import, import_and_publish) over many pages",
        description: "Runs in the background as the credential's owner. Poll GET /jobs/{id}. dryRun reports what would happen without writing. Each item succeeds or fails on its own.",
        parameters: [idempotencyKey],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["kind", "items"], properties: { kind: { type: "string", enum: ["commit", "publish", "import", "import_and_publish"] }, items: { type: "array", items: { type: "object", required: ["fileId"], properties: { fileId: { type: "string" } } } }, dryRun: { type: "boolean" }, policy: { type: "object" }, webhook: { type: "object", required: ["url", "secret"], description: "Called once with a signed JSON body when the job finishes: Pagefirst-Signature is t=<unix>,v1=HMAC-SHA256(secret, \"<t>.<body>\"). https and a public host only; retried 4 times with backoff.", properties: { url: { type: "string" }, secret: { type: "string", minLength: 16 } } } } } } } },
        responses: { "202": { description: "Accepted" }, default: error },
      },
    },
    "/jobs/{id}": {
      get: { operationId: "getJob", summary: "Job status, counts and per-item results", parameters: [jobId], responses: { "200": { description: "OK" }, default: error } },
    },
    "/jobs/{id}/cancel": {
      post: { operationId: "cancelJob", summary: "Stop a job; finished items stay finished", parameters: [jobId], responses: { "200": { description: "OK" }, default: error } },
    },
    "/jobs/{id}/resume": {
      post: { operationId: "resumeJob", summary: "Resume a cancelled or paused job", parameters: [jobId], responses: { "200": { description: "OK" }, default: error } },
    },
    "/jobs/{id}/report": {
      get: { operationId: "getJobReport", summary: "Per-item report as JSON, or CSV with ?format=csv", parameters: [jobId], responses: { "200": { description: "OK" }, default: error } },
    },
    "/themes": {
      get: { operationId: "listThemes", summary: "Themes a site can choose", responses: { "200": { description: "OK" }, default: error } },
    },
    "/site/theme": {
      get: { operationId: "getSiteTheme", summary: "The site's theme, lock, tokens and settings", responses: { "200": { description: "OK" }, default: error } },
      put: {
        operationId: "setSiteTheme",
        summary: "Change the site's theme, tokens or settings",
        description: "Published pages keep their old look until POST /site/republish.",
        parameters: [idempotencyKey],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { themeName: { type: "string" }, versionRange: { type: "string" }, tokens: { type: "object" }, settings: { type: "object" }, customCss: { type: "string" }, templateOverrides: { type: "object" }, locks: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "OK" }, default: error },
      },
    },
    "/site/theme/preview": {
      post: { operationId: "previewSiteTheme", summary: "Dry-run a theme change over a sample of published pages", requestBody: { required: true, content: { "application/json": { schema: { type: "object" } } } }, responses: { "200": { description: "OK" }, default: error } },
    },
    "/site/republish": {
      post: {
        operationId: "republishSite",
        summary: "Republish every published page as one job",
        description: "Pages whose revision, theme and site config are unchanged since their last publish are not rendered or uploaded again (item result unchanged: true).",
        parameters: [idempotencyKey],
        responses: { "202": { description: "Accepted" }, default: error },
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
