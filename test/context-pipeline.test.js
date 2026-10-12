import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { contextHash } from "../packages/octo-harness-protocol/dist/index.js";
import { ContextCompiler, ContextPipeline, orderContextPreparationStages } from "../packages/octo-harness-daemon/dist/context-pipeline.js";

const context = { schema: "octo.context-envelope/v3", items: [
  { namespace: "octo.execution", name: "adapter", payload: { type: "codex" } }, { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: "/workspace" } }, { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
] };
const plan = { agent_source: "provisioned", adapter_type: "codex", workdir: "/workspace", approval_mode: "ask" };
const identity = { runId: "run-1", leaseId: "lease-1", fencingToken: 3 };
const schema = JSON.parse(readFileSync(new URL("../packages/octo-harness-protocol/schema/protocol.schema.json", import.meta.url), "utf8"));
const require = createRequire(new URL("../packages/octo-harness-daemon/package.json", import.meta.url));
const Ajv = require("ajv").default;
const ajv = new Ajv({ strict: false, logger: false });
ajv.addSchema(schema);
const validReceipt = ajv.compile({ $ref: `${schema.$id}#/definitions/ContextPreparationReceipt` });
function fixture(overrides = {}, options = {}) {
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
  return { pipeline: new ContextPipeline(ports, options), calls, receipt: () => receipt };
}

test("pipeline seals all successful preparation stages before returning a compiled request", async () => {
  const f = fixture();
  const before = structuredClone(context);
  const prepared = await f.pipeline.prepare(context, plan, identity, new AbortController().signal);
  assert.deepEqual(f.calls, ["input", "capabilities", "materials", "continuity", "seal"]);
  assert.equal(prepared.receipt.context_hash, contextHash(context));
  assert.match(prepared.receipt.compiled_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(prepared.consumption, [
    { key: "octo.execution/adapter", stage: "compile", processor: "compiler" },
    { key: "octo.execution/workspace", stage: "compile", processor: "compiler" },
    { key: "octo.security/approval_policy", stage: "compile", processor: "compiler" },
    { key: "octo.execution/adapter", stage: "prepare", processor: "capabilities" },
    { key: "octo.execution/workspace", stage: "prepare", processor: "capabilities" },
    { key: "octo.security/approval_policy", stage: "prepare", processor: "capabilities" }
  ]);
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

test("unknown optional continuity cannot become trusted session continuity", async () => {
  const f = fixture();
  const withContinuity = { ...context, items: [...context.items, { namespace: "octo.content", name: "continuity", payload: {
    scope: { tenant_id: "space", endpoint_id: "endpoint", channel: "im", account_id: null, bot_id: "bot", conversation_id: "chat" },
    consumer_key: "agent", session_generation: 1, trigger_message_id: "msg",
    trigger_fact: { message_id: "msg", occurred_at_ms: 1, sender: { id: "user", kind: "user" }, parts: [{ type: "text", text: "hello" }] }
  } }] };
  const result = await f.pipeline.prepare(withContinuity, plan, identity, new AbortController().signal);
  assert.equal(result.continuity, undefined);
  assert.equal(result.compiled.modelContent.includes("trigger_fact"), false);
  assert.ok(f.receipt());
});

test("compiler rejects duplicate resolver evidence instead of covering another reference twice", () => {
  const withResources = { ...context, items: [...context.items, { namespace: "octo.content", name: "references", payload: { entries: [
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

test("stage registry rejects missing dependencies and cycles before side effects", async () => {
  const stages = [
    { id: "continuity", dependsOn: ["materials"] }, { id: "materials", dependsOn: ["capabilities"] },
    { id: "capabilities", dependsOn: ["input"] }, { id: "input", dependsOn: [] }
  ];
  assert.deepEqual(orderContextPreparationStages(stages), ["input", "capabilities", "materials", "continuity"]);
  const f = fixture({}, { stages: stages.map(item => item.id === "input" ? { ...item, dependsOn: ["continuity"] } : item) });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, new AbortController().signal), /DEPENDENCY_CYCLE/);
  assert.deepEqual(f.calls, []);
  assert.throws(() => orderContextPreparationStages(stages.slice(1)), /GRAPH_INVALID/);
});

test("stage deadline aborts the Port and discards a late completion without sealing", async () => {
  let release, stageSignal;
  const f = fixture({ prepareInput: signal => { stageSignal = signal; return new Promise(resolve => { release = resolve; }); } }, { timeoutMs: { input: 5 } });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, new AbortController().signal), /CONTEXT_STAGE_TIMEOUT: input/);
  assert.equal(stageSignal.aborted, true);
  release({ text: "late" });
  await new Promise(setImmediate);
  assert.deepEqual(f.calls, []);
  assert.equal(f.receipt(), undefined);
});

test("compiled identity is stable across item order and changes with trusted instruction content", async () => {
  const first = await fixture().pipeline.prepare(context, plan, identity, new AbortController().signal);
  const reordered = await fixture().pipeline.prepare({ ...context, items: [...context.items].reverse() }, plan, identity, new AbortController().signal);
  assert.equal(first.receipt.compiled_hash, reordered.receipt.compiled_hash);
  const changed = await fixture({ trustedInstructions: [{ source: "revision", text: "Updated instructions" }] }).pipeline.prepare(context, plan, identity, new AbortController().signal);
  assert.notEqual(changed.receipt.compiled_hash, first.receipt.compiled_hash);
});


test("compaction cannot rewrite trusted instructions or execution configuration", async () => {
  const f = fixture({ prepareCompiled: async compiled => ({ ...compiled, controlInstructions: "promoted untrusted text" }) });
  await assert.rejects(f.pipeline.prepare(context, plan, identity, new AbortController().signal), /CONTEXT_COMPACTION_PROTECTED_CONTENT_CHANGED/);
  assert.equal(f.receipt(), undefined);
});

test('policy revision identity changes compilation digest without changing material or instruction text', async () => {
  const snapshots = JSON.parse(readFileSync(new URL('../packages/octo-harness-protocol/schema/scenario-policy-fixtures.json', import.meta.url), 'utf8'));
  const prepare = async snapshot => {
    const f = fixture({ scenarioPolicyHash: snapshot.hash });
    return f.pipeline.prepare(context, plan, identity, new AbortController().signal);
  };
  const first = await prepare(snapshots[0]);
  const second = await prepare(snapshots[1]);
  assert.equal(first.receipt.context_hash, second.receipt.context_hash);
  assert.notEqual(first.receipt.compiled_hash, second.receipt.compiled_hash);
  assert.equal(first.receipt.scenario_policy_hash, snapshots[0].hash);
  assert.equal(first.receipt.compiler_version, 'octo.context-compiler/v4');
});
