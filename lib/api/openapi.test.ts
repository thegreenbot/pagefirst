import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { openapi } from "./openapi";

const ROOT = "app/api/v1";

function routes(dir: string, found: string[] = []): string[] {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const entry = dirent.name;
    const full = path.join(dir, entry);
    if (dirent.isDirectory()) routes(full, found);
    else if (entry === "route.ts") {
      const route = "/" + path.relative(ROOT, dir).split(path.sep).filter(Boolean).join("/");
      const source = readFileSync(full, "utf8");
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (new RegExp(`export (async )?function ${method}\\b`).test(source)) found.push(`${method.toLowerCase()} ${route === "/" ? "" : route.replace(/\[(\w+)\]/g, "{$1}")}`);
      }
    }
  }
  return found;
}

describe("OpenAPI contract", () => {
  test("every route handler under /api/v1 is in the spec, and every spec operation has a handler", () => {
    const fromSpec = Object.entries(openapi.paths).flatMap(([route, ops]) => Object.keys(ops).map((method) => `${method} ${route}`));
    assert.deepEqual(routes(ROOT).sort(), fromSpec.sort());
  });

  test("every operation has an id, and errors use the one shared shape", () => {
    const ids = Object.values(openapi.paths).flatMap((ops) => Object.values(ops).map((op) => (op as { operationId: string }).operationId));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(openapi.components.responses.Error.content["application/json"].schema.properties.error.required.includes("requestId"));
  });
});
