import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { API_ERROR_CODES, apiCodeFor, apiError } from "./v1";

describe("/api/v1 errors", () => {
  test("one shape, with the request id in body and header", async () => {
    const response = apiError("req-1", "revision_conflict", "stale", { revisionId: "r2" });
    assert.equal(response.status, 409);
    assert.equal(response.headers.get("x-request-id"), "req-1");
    assert.deepEqual(await response.json(), { error: { code: "revision_conflict", message: "stale", details: { revisionId: "r2" }, requestId: "req-1" } });
  });

  test("service codes map to stable API codes", () => {
    assert.equal(apiCodeFor("conflict"), "revision_conflict");
    assert.equal(apiCodeFor("upstream_quota"), "google_quota");
    for (const code of ["unauthenticated", "forbidden", "not_found", "invalid", "unsupported", "rate_limited", "upstream_error"] as const) {
      assert.ok((API_ERROR_CODES as readonly string[]).includes(apiCodeFor(code)));
    }
  });
});
