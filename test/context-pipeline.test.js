import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { contextHash } from "../packages/octo-harness-protocol/dist/index.js";
import { ContextCompiler, ContextPipeline } from "../packages/octo-harness-daemon/dist/context-pipeline.js";

const context = { schema: "octo.context-envelope/v1", items: [
  { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } },
  { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: "/workspace" } },
  { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
] };
const plan = { adapter_type: "codex", workdir: "/workspace", approval_mode: "ask" };
const identity = { runId: "run-1", leaseId: "lease-1", fencingToken: 3 };
const schema = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/protocol.schema.json", import.meta.url), "utf8"));
const require = createRequire(new URL("../packages/octo-harness-daemon/package.json", import.meta.url));
const Ajv = require("ajv").default;
const ajv = new Ajv({ strict: false, logger: false });
ajv.addSchema(schema);
const validReceipt = ajv.compile({ $ref: `${schema.$id}#/definitions/ContextPreparationReceipt` });
function fixture(overrides = {}) {
  const calls = [];
  let receipt;
  const ports = {
    prepareInput: async () => { calls.push("input"); return { text: "hello" }; },
    prepareCapabilities: async () => { calls.push("capabilities"); return { workdir: "/workspace", providerStateDir: "/state", skills: [], skillRoots: [], mcpServers: {}, receipt: {
      workspace_mode: "fixed", workspace_path: "/workspace", provider_state_dir: "/state", resources: [], warnings: []
    } }; },
    prepareMaterials: async () => { calls.push("materials"); },
    prepareContinuity: async () => { calls.push("continuity"); },
    seal: async value => { calls.push("seal"); receipt = value; }, ...overrides
  };
  return { pipeline: new ContextPipeline(ports), calls, receipt: () => receipt };
}

test("pipeline seals all successful preparation stages before returning a compiled request", async () => {
  const f = fixture();
  const before = structuredClone(context);
  const prepared = await f.pipeline.prepare(context, plan, identity, new AbortController().signal);
  assert.deepEqual(f.calls, ["input", "capabilities", "materials", "continuity", "seal"]);
  assert.equal(prepared.receipt.context_hash, contextHash(context));
  assert.equal(prepared.receipt.run_id, identity.runId);
  assert.equal(prepared.receipt.lease_id, identity.leaseId);
  assert.equal(prepared.receipt.fencing_token, identity.fencingToken);
  assert.deepEqual(prepared.receipt.materials, []);
  assert.deepEqual(context, before);
  assert.deepEqual(f.receipt(), prepared.receipt);
  assert.equal(validReceipt(prepared.receipt), true, JSON.stringify(validReceipt.errors));
  assert.equal(validReceipt({ ...prepared.receipt, fencing_token: 0 }), false);
  const { context_hash, ...unbound } = prepared.receipt;
  assert.equal(validReceipt(unbound), false);
});

test("material failure cannot seal a prepared workspace as a fully prepared Context", async () => {
  const f = fixture({ prepareMaterials: async () => { throw new Error("MATERIAL_UNAVAILABLE"); } });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, new AbortController().signal), /MATERIAL_UNAVAILABLE/);
  assert.equal(f.receipt(), undefined);
});

test("cancellation between preparation stages prevents later work and sealing", async () => {
  const controller = new AbortController();
  const f = fixture({ prepareInput: async () => { controller.abort(new Error("cancelled")); return {}; } });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, controller.signal), /cancelled/);
  assert.deepEqual(f.calls, []);
});

test("declared continuity without snapshot evidence fails before sealing", async () => {
  const f = fixture();
  const withContinuity = { ...context, items: [...context.items, { namespace: "octo.content", name: "continuity", payload: {
    scope: { tenant_id: "space", endpoint_id: "endpoint", channel: "im", account_id: null, bot_id: "bot", conversation_id: "chat" },
    consumer_key: "agent", session_generation: 1, trigger_message_id: "msg",
    trigger_fact: { message_id: "msg", occurred_at_ms: 1, sender: { id: "user", kind: "user" }, parts: [{ type: "text", text: "hello" }] }
  } }] };
  await assert.rejects(f.pipeline.prepare(withContinuity, plan, identity, new AbortController().signal), /CONTEXT_CONTINUITY_UNAVAILABLE/);
  assert.equal(f.receipt(), undefined);
});

test("compiler rejects duplicate resolver evidence instead of covering another reference twice", () => {
  const withResources = { ...context, items: [...context.items, { namespace: "octo.content", name: "resources", payload: { entries: [
    { resource_ref: "task/1", resolver: "mcp", locator: { server_ref: "octo_task", tool: "task_get_materials" }, params: { task_id: "1" } },
    { resource_ref: "task/2", resolver: "mcp", locator: { server_ref: "octo_task", tool: "task_get_materials" }, params: { task_id: "2" } }
  ] } }] };
  assert.throws(() => new ContextCompiler().compile(withResources, { selections: [
    { resource_ref: "task/1", text: "one" }, { resource_ref: "task/1", text: "duplicate" }
  ], refs: [] }), /CONTEXT_RESOLVER_UNAVAILABLE/);
});

test("seal rejection cannot produce an invocable prepared result", async () => {
  const f = fixture({ seal: async () => { throw new Error("RUN_LEASE_MISMATCH"); } });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, new AbortController().signal), /RUN_LEASE_MISMATCH/);
});

test("host-authenticated revision instructions compile through the same trusted channel", () => {
  const compiled = new ContextCompiler().compile(context, undefined, [{ source: "revision", text: "Use approved tools" }]);
  assert.equal(compiled.controlInstructions, "Use approved tools");
  assert.equal(compiled.modelContent, "");
});
