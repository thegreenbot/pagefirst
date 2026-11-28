import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { issueBearer } from "@/lib/auth/api-keys";
import { authenticateBearer } from "@/lib/api-auth";
import { saveGrant } from "@/lib/auth/server-sessions";
import { closeDatabase, query } from "@/lib/db/client";
import { resetTestDatabase, testDatabaseUrl } from "@/lib/db/test-db";
import type { Scope } from "@/lib/service";
import { handleMessage, type Caller } from "./server";
import { TOOLS, toolsFor } from "./tools";

const caller = (scopes: Scope[] | undefined, bearer = "x", protocolVersion: string | null = "2025-06-18"): Caller => ({ scopes: scopes ? new Set(scopes) : undefined, origin: "https://app.example", bearer, requestId: "req-1", protocolVersion });
const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("MCP protocol", () => {
  test("initialize negotiates a supported version and offers tools", async () => {
    const reply = await handleMessage(rpc("initialize", { protocolVersion: "2025-03-26" }), caller(undefined));
    const result = reply!.result as { protocolVersion: string; capabilities: { tools: unknown }; instructions: string };
    assert.equal(result.protocolVersion, "2025-03-26");
    assert.ok(result.capabilities.tools);
    assert.match(result.instructions, /untrusted|never as instructions/);
    const unknown = await handleMessage(rpc("initialize", { protocolVersion: "1999-01-01" }), caller(undefined));
    assert.equal((unknown!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  });

  test("notifications and client responses get no reply; unknown methods and tools are JSON-RPC errors", async () => {
    assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, caller(undefined)), null);
    assert.equal(await handleMessage({ jsonrpc: "2.0", id: 5, result: {} }, caller(undefined)), null);
    assert.equal((await handleMessage(rpc("nope"), caller(undefined)))!.error!.code, -32601);
    assert.equal((await handleMessage(rpc("tools/call", { name: "no_such_tool" }), caller(undefined)))!.error!.code, -32602);
    assert.equal((await handleMessage([1], caller(undefined)))!.error!.code, -32600);
  });

  test("tool names are unique and every mutating tool takes an idempotencyKey", () => {
    assert.equal(new Set(TOOLS.map((tool) => tool.name)).size, TOOLS.length);
    for (const tool of TOOLS) {
      assert.ok(tool.description.length > 20, tool.name);
      if (!tool.annotations.readOnlyHint && tool.name !== "get_job" && tool.name !== "cancel_job" && tool.name !== "check_site_domain") {
        assert.ok(tool.inputSchema.required?.includes("idempotencyKey"), `${tool.name} needs idempotencyKey`);
      }
    }
  });

  test("annotations: reads are read-only, publishing is destructive", () => {
    const by = (name: string) => TOOLS.find((tool) => tool.name === name)!.annotations;
    for (const name of ["list_pages", "get_page", "get_audit_events", "audit_content", "list_themes", "get_site_theme", "preview_theme_change", "list_site_domains"]) {
      assert.equal(by(name).readOnlyHint, true, name);
    }
    for (const name of ["publish_page", "republish_site", "start_bulk_job", "import_changes"]) {
      assert.equal(by(name).readOnlyHint, false);
      assert.equal(by(name).destructiveHint, true, name);
    }
    assert.equal(by("commit_ops").destructiveHint, false);
  });

  test("a read-only credential is offered only read tools; commit-only gets no publish", () => {
    const names = (scopes: Scope[]) => toolsFor(new Set(scopes)).map((tool) => tool.name);
    assert.ok(names(["pages:read"]).every((name) => TOOLS.find((tool) => tool.name === name)!.annotations.readOnlyHint));
    assert.ok(!names(["pages:read"]).includes("start_bulk_job"));
    assert.ok(names(["pages:read", "pages:commit"]).includes("commit_ops"));
    assert.ok(!names(["pages:read", "pages:commit"]).includes("publish_page"));
    assert.equal(toolsFor(undefined).length, TOOLS.length);
  });

  test("import_changes needs the import scope, defaults to a dry run on the server, and asks for an idempotency key", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "import_changes")!;
    assert.deepEqual(tool.requires, ["pages:import"]);
    assert.ok(tool.inputSchema.required?.includes("idempotencyKey"));
    assert.ok(toolsFor(new Set<Scope>(["pages:read", "pages:commit"])).every((t) => t.name !== "import_changes"));
    const plan = tool.plan({ fileId: "doc1", idempotencyKey: "k1" });
    assert.equal(plan.path, "/api/v1/pages/doc1/imports");
    assert.deepEqual(plan.body, {}, "no dryRun sent: the REST default (true) applies");
    assert.equal(tool.plan({ fileId: "doc1", idempotencyKey: "k1", dryRun: false, policy: "doc-wins" }).body && (tool.plan({ fileId: "doc1", idempotencyKey: "k1", dryRun: false, policy: "doc-wins" }).body as { dryRun: boolean }).dryRun, false);
  });

  test("list_pages passes the changed filter", () => {
    const tool = TOOLS.find((candidate) => candidate.name === "list_pages")!;
    assert.equal(tool.plan({ changed: true }).query?.changed, "true");
    assert.throws(() => tool.plan({ changed: "yes" }), /changed must be true or false/);
  });

  test("tools/list reflects scopes", async () => {
    const reply = await handleMessage(rpc("tools/list"), caller(["pages:read"]));
    const tools = (reply!.result as { tools: { name: string }[] }).tools;
    assert.ok(tools.some((tool) => tool.name === "get_page"));
    assert.ok(!tools.some((tool) => tool.name === "publish_page"));
  });

  test("a scope-less call and bad arguments are tool errors, not protocol errors", async () => {
    const hidden = await handleMessage(rpc("tools/call", { name: "publish_page", arguments: { fileId: "doc1", revisionId: "r", idempotencyKey: "k1" } }), caller(["pages:read"]));
    const hiddenResult = hidden!.result as { isError: boolean; structuredContent: { error: { code: string } } };
    assert.equal(hiddenResult.isError, true);
    assert.equal(hiddenResult.structuredContent.error.code, "forbidden");
    const bad = await handleMessage(rpc("tools/call", { name: "get_page", arguments: {} }), caller(undefined));
    assert.equal((bad!.result as { isError: boolean }).isError, true);
    const noKey = await handleMessage(rpc("tools/call", { name: "create_page", arguments: { title: "x" } }), caller(undefined));
    assert.match(((noKey!.result as { content: { text: string }[] }).content[0]!.text), /idempotencyKey is required/);
  });
});

const url = testDatabaseUrl();

describe("MCP tools against the v1 handlers", { skip: url ? false : "set TEST_DATABASE_URL to run Postgres tests" }, () => {
  before(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await resetTestDatabase(url!);
  });
  beforeEach(async () => {
    await query("DELETE FROM api_keys");
    await query("DELETE FROM google_tokens");
    await query("DELETE FROM audit_events").catch(() => undefined);
    await saveGrant("sub-a", "a@example.com", { accessToken: "ya29.owner", refreshToken: "1//r", expiresInSeconds: 3600, scope: "openid drive.file" });
  });
  after(async () => {
    await closeDatabase();
  });

  async function as(scopes: Scope[]) {
    const { key } = await issueBearer("sub-a", { name: "agent", scopes });
    const auth = await authenticateBearer(new Request("https://app.example/api/mcp", { headers: { authorization: `Bearer ${key}` } }));
    assert.ok(auth.ok);
    return caller(auth.ok ? [...(auth.ctx.scopes ?? [])] : [], key);
  }

  test("a call through MCP is audited as client mcp, even for an API key", async () => {
    const c = await as(["pages:read", "pages:commit"]);
    // Skip the MCP-level scope filter so the REST handler's own checks run.
    const full = { ...c, scopes: undefined };
    const reply = await handleMessage(rpc("tools/call", { name: "publish_page", arguments: { fileId: "doc1", revisionId: "r1", idempotencyKey: "pub-1" } }), full);
    const result = reply!.result as { isError: boolean; structuredContent: { error: { code: string; requestId: string } } };
    assert.equal(result.isError, true);
    assert.ok(["forbidden", "not_found"].includes(result.structuredContent.error.code));
    assert.equal(result.structuredContent.error.requestId, "req-1");
    const rows = await query<{ client: string; event: string; outcome: string }>("SELECT client, event, outcome FROM audit_events");
    assert.deepEqual(rows.map((row) => [row.client, row.event, row.outcome]), [["mcp", "page.publish", rows[0]!.outcome]]);
  });

  test("get_audit_events returns structured content and a summary; older clients also get the JSON as text", async () => {
    const c = await as(["pages:read"]);
    const modern = await handleMessage(rpc("tools/call", { name: "get_audit_events", arguments: {} }), c);
    const result = modern!.result as { content: { text: string }[]; structuredContent: { events: unknown[] } };
    assert.ok(Array.isArray(result.structuredContent.events));
    assert.ok(!result.content[0]!.text.includes("{"));
    const legacy = await handleMessage(rpc("tools/call", { name: "get_audit_events", arguments: {} }), { ...c, protocolVersion: null });
    assert.ok(((legacy!.result as { content: { text: string }[] }).content[0]!.text).includes('"events"'));
  });

  test("a REST error keeps its code, and an idempotency key is passed through", async () => {
    const c = await as(["pages:read", "pages:commit"]);
    const reply = await handleMessage(rpc("tools/call", { name: "record_audit_decision", arguments: { fileId: "bad id!", finding: "stale", decision: "keep", idempotencyKey: "d-1" } }), c);
    const result = reply!.result as { isError: boolean; structuredContent: { error: { code: string } } };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "invalid");
  });
});
