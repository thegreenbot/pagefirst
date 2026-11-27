import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readTextCapped } from "./body";

function streamed(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("https://app.example/x", { method: "POST", body, duplex: "half" } as RequestInit);
}

describe("readTextCapped", () => {
  test("reads a body under the cap", async () => {
    assert.deepEqual(await readTextCapped(streamed(["{\"a\":", "1}"]), 100), { ok: true, text: "{\"a\":1}" });
  });

  test("stops a streamed body that passes the cap", async () => {
    assert.deepEqual(await readTextCapped(streamed(["x".repeat(60), "x".repeat(60)]), 100), { ok: false, reason: "too_large" });
  });

  test("refuses early on a declared Content-Length over the cap", async () => {
    const req = new Request("https://app.example/x", { method: "POST", body: "x".repeat(10), headers: { "content-length": "500" } });
    assert.deepEqual(await readTextCapped(req, 100), { ok: false, reason: "too_large" });
  });

  test("treats a missing body as empty", async () => {
    assert.deepEqual(await readTextCapped(new Request("https://app.example/x", { method: "POST" }), 100), { ok: true, text: "" });
  });
});
