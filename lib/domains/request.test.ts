import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { domainErrorResponse } from "./request";
import { DomainServiceError } from "./service";

describe("domain error responses", () => {
  test("each service error maps to a status the editor can show", async () => {
    const expected = { invalid: 400, limit: 402, taken: 409, not_found: 404, unavailable: 503, provider: 502 } as const;
    for (const [code, status] of Object.entries(expected)) {
      const response = domainErrorResponse(new DomainServiceError(code as keyof typeof expected, "message"));
      assert.equal(response.status, status, code);
      assert.deepEqual(await response.json(), { error: "message", code });
    }
  });

  test("an unexpected error is not turned into a response", () => {
    assert.throws(() => domainErrorResponse(new Error("boom")), /boom/);
  });
});
