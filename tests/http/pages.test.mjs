import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { startApp } from "./server.mjs";

async function postJson(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("page routes in sample mode", () => {
  let app;
  before(async () => {
    app = await startApp({ google: false });
  });
  after(async () => {
    await app?.stop();
  });

  test("lists sample pages", async () => {
    const res = await fetch(`${app.base}/api/pages`);
    assert.equal(res.status, 200);
    const library = await res.json();
    assert.equal(library.sample, true);
    assert.ok(library.pages.some((page) => page.fileId === "about"));
  });

  test("reads a page, 404s an unknown one, 400s an unsafe id", async () => {
    assert.equal((await fetch(`${app.base}/api/pages/about`)).status, 200);
    assert.equal((await fetch(`${app.base}/api/pages/nope`)).status, 404);
    assert.equal((await fetch(`${app.base}/api/pages/bad%20id`)).status, 400);
  });

  test("commit rejects an unsafe id, bad JSON and malformed bodies with 400", async () => {
    const cases = [
      ["/api/pages/bad%20id/commit", { baseRevisionId: "r1", ops: [] }],
      ["/api/pages/about/commit", "{not json"],
      ["/api/pages/about/commit", []],
      ["/api/pages/about/commit", { baseRevisionId: "r1", ops: "nope" }],
      ["/api/pages/about/commit", { baseRevisionId: 1, ops: [] }],
    ];
    for (const [path, body] of cases) {
      const res = await postJson(app.base, path, body);
      assert.equal(res.status, 400, `${path} ${JSON.stringify(body)}`);
      assert.ok((await res.json()).error);
    }
  });

  test("commit on a stale revision is a 409 with the current page", async () => {
    const res = await postJson(app.base, "/api/pages/about/commit", { baseRevisionId: "r0", ops: [] });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.page.fileId, "about");
  });

  test("commit with an op on an unknown node is a 400", async () => {
    const current = await (await fetch(`${app.base}/api/pages/about`)).json();
    const res = await postJson(app.base, "/api/pages/about/commit", {
      baseRevisionId: current.page.revisionId,
      ops: [{ op: "replaceText", nodeId: "n_missing", text: "x" }],
    });
    assert.equal(res.status, 400);
  });

  test("commit with an unknown op is a 400", async () => {
    const current = await (await fetch(`${app.base}/api/pages/about`)).json();
    const res = await postJson(app.base, "/api/pages/about/commit", {
      baseRevisionId: current.page.revisionId,
      ops: [{ op: "dropTable" }],
    });
    assert.equal(res.status, 400);
  });

  test("a valid commit advances the revision", async () => {
    const current = await (await fetch(`${app.base}/api/pages/about`)).json();
    const res = await postJson(app.base, "/api/pages/about/commit", {
      baseRevisionId: current.page.revisionId,
      ops: [{ op: "setMetadata", key: "description", value: "Changed in a test." }],
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.notEqual(body.page.revisionId, current.page.revisionId);
    assert.equal(body.page.metadata.description, "Changed in a test.");
  });
});

describe("page routes signed in to Google", () => {
  let app;
  const signedIn = { cookie: "pf_access=fake-token" };
  before(async () => {
    app = await startApp({ google: true });
  });
  after(async () => {
    await app?.stop();
  });

  test("lists Docs from Drive", async () => {
    const res = await fetch(`${app.base}/api/pages`, { headers: signedIn });
    assert.equal(res.status, 200);
    const library = await res.json();
    assert.equal(library.sample, false);
    assert.deepEqual(library.pages.map((page) => page.fileId), ["doc1"]);
  });

  test("an expired or forged session cannot list Docs", async () => {
    const res = await fetch(`${app.base}/api/pages`, { headers: { cookie: "pf_access=forged" } });
    assert.equal(res.status, 500);
    assert.doesNotMatch(await res.text(), /forged/);
  });

  test("reads a Doc and 404s a missing one", async () => {
    assert.equal((await fetch(`${app.base}/api/pages/doc1`, { headers: signedIn })).status, 200);
    assert.equal((await fetch(`${app.base}/api/pages/missing`, { headers: signedIn })).status, 404);
  });

  test("commit on a stale revision is a 409 and writes nothing", async () => {
    const res = await postJson(app.base, "/api/pages/doc1/commit", { baseRevisionId: "rev-1", ops: [] }, signedIn);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).page.revisionId, "rev-2");
  });

  test("a Docs failure is a 502 that does not leak the token", async () => {
    const res = await postJson(app.base, "/api/pages/boom/commit", { baseRevisionId: "rev-2", ops: [] }, signedIn);
    assert.equal(res.status, 502);
    const text = await res.text();
    assert.doesNotMatch(text, /fake-token/);
    assert.doesNotMatch(text, /test-client-secret/);
  });

  test("an empty commit on the current revision succeeds", async () => {
    const res = await postJson(app.base, "/api/pages/doc1/commit", { baseRevisionId: "rev-2", ops: [] }, signedIn);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).sample, false);
  });
});
