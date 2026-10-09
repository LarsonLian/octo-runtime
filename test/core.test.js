import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "@mininglamp-oss/octo-harness-adapter-host";
import { HarnessEngine, MemoryStore } from "@mininglamp-oss/octo-harness-core";
import { testAdapter } from "./fixtures/test-adapter.js";

const emptyContext = () => ({ schema: "octo.context-envelope/v1", items: [] });
const defaultContext = (mode = "full_access", model = "model-1") => ({
  schema: "octo.context-envelope/v1",
  items: [
    { namespace: "octo.execution", name: "adapter", payload: { type: "test" } },
    { namespace: "octo.execution", name: "workspace", payload: { mode: "fixed", path: process.cwd() } },
    { namespace: "octo.execution", name: "model", payload: { id: model } },
    { namespace: "octo.security", name: "approval_policy", payload: { mode } }
  ]
});

function capturingEngine() {
  const requests = [];
  const host = {
    list: () => [{ type: "test" }, { type: "other" }],
    async *invoke(adapterType, request) {
      requests.push({ adapterType, request: structuredClone(request) });
      yield { protocolVersion: 2, type: "session.update", payload: { providerSession: { sessionId: `provider-${request.runId}` } } };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    },
    cancel: () => true
  };
  const store = new MemoryStore();
  return { engine: new HarnessEngine({ store, host }), store, requests };
}

const submission = (agentId, occurrenceId = "occurrence-1", context = emptyContext()) => ({
  namespace: "local", agentId, sessionKey: "v1/task/frozen",
  trigger: { kind: "manual", occurrenceId }, input: { prompt: "Do once" }, context
});

test("one trigger occurrence creates one AgentRun and preserves Provider resume state", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext() });
  const request = {
    namespace: "loop",
    agentId: agent.id,
    sessionKey: "v1/task/task-1",
    trigger: { kind: "loop.task.manual", occurrenceId: "task-event/event-1" },
    input: { prompt: "Do T" }, context: emptyContext()
  };
  const first = await engine.submitAgentRun(request);
  const result = await engine.executeRun(first.agentRun.id);
  const duplicate = await engine.submitAgentRun(request);
  assert.equal(result.run.status, "completed");
  assert.equal(result.events[0].type, "run.queued");
  assert.equal(result.events[1].type, "run.started");
  assert.equal(result.events.at(-1).type, "run.completed");
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.agentRun.id, first.agentRun.id);
  assert.equal(store.listAgentRuns().length, 1);
  assert.equal(store.getAgentSession(first.agentSession.id).providerSession.sessionId, `test:${first.agentSession.id}`);
});

test("same occurrence with changed input is rejected", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext() });
  const base = {
    namespace: "webhook", agentId: agent.id, sessionKey: "v1/hook/h-1/subject/s-1",
    trigger: { kind: "webhook.delivery", occurrenceId: "delivery/d-1" }, context: emptyContext()
  };
  await engine.submitAgentRun({ ...base, input: { prompt: "one" } });
  await assert.rejects(engine.submitAgentRun({ ...base, input: { prompt: "two" } }), /different AgentRun request/);
});

test("only one concurrent executeRun call can claim a queued AgentRun", async () => {
  const host = new AdapterHost(); host.register(testAdapter);
  const store = new MemoryStore(); const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "test", defaultContext: defaultContext() });
  const submitted = await engine.submitAgentRun({
    namespace: "loop",
    agentId: agent.id,
    sessionKey: "v1/task/concurrent",
    trigger: { kind: "loop.task.manual", occurrenceId: "task-event/concurrent" },
    input: { prompt: "Do once" }, context: emptyContext()
  });

  const outcomes = await Promise.allSettled([
    engine.executeRun(submitted.agentRun.id),
    engine.executeRun(submitted.agentRun.id)
  ]);

  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(outcome => outcome.status === "rejected").length, 1);
  assert.equal(store.getEvents(submitted.agentRun.id).filter(item => item.type === "run.started").length, 1);
});

test("submitted Run freezes defaults and materialization before Agent changes", async () => {
  const { engine, store, requests } = capturingEngine();
  const originalDefaults = defaultContext("ask");
  originalDefaults.items.push({ namespace: "octo.execution", name: "reasoning", payload: { effort: "low" } });
  const agent = await engine.registerAgent({ agentSource: "provisioned",
    name: "original", defaultContext: originalDefaults,
    config: { providerAgentId: "original-provider", providerOptions: { endpoint: "original" } }
  });
  const input = submission(agent.id);
  const first = await engine.submitAgentRun(input);
  const changedDefaults = defaultContext("full_access", "model-2");
  changedDefaults.items.find(item => item.name === "workspace").payload.path = `${process.cwd()}/future-workspace`;
  changedDefaults.items.push({ namespace: "octo.execution", name: "reasoning", payload: { effort: "high" } });
  const updated = await engine.replaceDefaultContext({ agentId: agent.id, expectedVersion: 1, context: changedDefaults });
  updated.name = "changed";
  updated.config.providerAgentId = "changed-provider";
  updated.config.providerOptions.endpoint = "changed";
  store.putAgent(updated);
  input.input.prompt = "caller mutation";
  first.agentRun.resolvedExecutionPlan.model = "result mutation";
  await engine.executeRun(first.agentRun.id);
  assert.equal(requests[0].request.agentConfig.model, "model-1");
  assert.equal(requests[0].request.agentConfig.effort, "low");
  assert.equal(requests[0].request.workdir, process.cwd());
  assert.equal(requests[0].request.agentConfig.providerAgentId, "original-provider");
  assert.equal(requests[0].request.agentConfig.providerOptions.endpoint, "original");
  assert.equal(requests[0].request.approvalMode, "ask");
  assert.equal(requests[0].request.prompt, "Do once");
  assert.equal(requests[0].request.runMetadata.agent.name, "original");
  const duplicate = await engine.submitAgentRun(submission(agent.id));
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.agentRun.contextDefaultsVersion, 1);
  assert.equal(duplicate.agentRun.resolvedExecutionPlan.model, "model-1");
  const next = await engine.submitAgentRun(submission(agent.id, "occurrence-2"));
  await engine.executeRun(next.agentRun.id);
  assert.equal(next.agentRun.contextDefaultsVersion, 2);
  assert.equal(requests[1].request.agentConfig.model, "model-2");
  assert.equal(requests[1].request.agentConfig.effort, "high");
  assert.equal(requests[1].request.workdir, `${process.cwd()}/future-workspace`);
  assert.equal(requests[1].request.agentConfig.providerAgentId, "changed-provider");
  assert.equal(requests[1].request.approvalMode, "full_access");
  assert.equal(requests[1].request.providerSession, undefined);
});

test("per-Run approval overrides are frozen and do not change Agent defaults", async () => {
  const { engine, store, requests } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "approval", defaultContext: defaultContext("ask") });
  for (const mode of ["ask", "assisted", "full_access"]) {
    const context = { schema: "octo.context-envelope/v1", items: [
      { namespace: "octo.security", name: "approval_policy", payload: { mode } }
    ] };
    const result = await engine.submitAgentRun(submission(agent.id, mode, context));
    context.items[0].payload.mode = "ask";
    assert.equal(result.agentRun.resolvedExecutionPlan.approval_mode, mode);
    await engine.executeRun(result.agentRun.id);
    assert.equal(requests.at(-1).request.approvalMode, mode);
    assert.equal(requests.at(-1).request.context.items.find(item => item.name === "approval_policy").payload.mode, mode);
  }
  assert.equal(store.getAgent(agent.id).contextDefaultsVersion, 1);
  assert.equal(store.getAgent(agent.id).defaultContext.items.find(item => item.name === "approval_policy").payload.mode, "ask");
});

test("occurrence hashing uses canonical submitted Context, not item order or current defaults", async () => {
  const { engine, store } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "hash", defaultContext: defaultContext() });
  const context = { schema: "octo.context-envelope/v1", items: [
    { namespace: "octo.execution", name: "model", payload: { id: "override" } },
    { namespace: "octo.security", name: "approval_policy", payload: { mode: "ask" } }
  ] };
  const first = await engine.submitAgentRun(submission(agent.id, "hash", context));
  await engine.replaceDefaultContext({ agentId: agent.id, expectedVersion: 1, context: defaultContext("assisted", "changed") });
  const reordered = { items: [...context.items].reverse().map(item => ({ payload: item.payload, name: item.name, namespace: item.namespace })), schema: context.schema };
  const duplicate = await engine.submitAgentRun(submission(agent.id, "hash", reordered));
  assert.equal(duplicate.agentRun.id, first.agentRun.id);
  assert.equal(duplicate.agentRun.contextHash, first.agentRun.contextHash);
  assert.equal(duplicate.agentRun.contextDefaultsVersion, 1);
  const changed = structuredClone(context);
  changed.items[0].payload.id = "different";
  await assert.rejects(engine.submitAgentRun(submission(agent.id, "hash", changed)), /different AgentRun request/);
  await assert.rejects(engine.submitAgentRun(submission(agent.id, "hash", emptyContext())), /different AgentRun request/);
  assert.equal(store.listAgentRuns().length, 1);
});

test("default Context replacement uses CAS without changing stable materialization", async () => {
  const { engine, store } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "CAS", defaultContext: defaultContext() });
  const changed = defaultContext("ask");
  changed.items.find(item => item.name === "adapter").payload.type = "other";
  const outcomes = await Promise.allSettled([
    engine.replaceDefaultContext({ agentId: agent.id, expectedVersion: 1, context: changed }),
    engine.replaceDefaultContext({ agentId: agent.id, expectedVersion: 1, context: defaultContext("assisted") })
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find(outcome => outcome.status === "rejected").reason.message, /VERSION_CONFLICT/);
  assert.equal(store.getAgent(agent.id).adapterType, "test");
  assert.equal(store.getAgent(agent.id).contextDefaultsVersion, 2);
});

test("local defaults choose ask explicitly and Provider defaults remove inherited model and effort", async () => {
  const { engine, requests } = capturingEngine();
  const defaults = defaultContext();
  defaults.items = defaults.items.filter(item => item.name !== "approval_policy");
  defaults.items.push({ namespace: "octo.execution", name: "reasoning", payload: { effort: "high" } });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "defaults", defaultContext: defaults });
  const result = await engine.submitAgentRun(submission(agent.id, "defaults", { schema: defaults.schema, items: [
    { namespace: "octo.execution", name: "model", payload: { use_provider_default: true } },
    { namespace: "octo.execution", name: "reasoning", payload: { use_provider_default: true } },
    { namespace: "octo.execution", name: "limits", payload: { run_timeout_ms: 2000 } }
  ] }));
  await engine.executeRun(result.agentRun.id);
  assert.equal(requests[0].request.approvalMode, "ask");
  assert.equal(requests[0].request.agentConfig.model, undefined);
  assert.equal(requests[0].request.agentConfig.effort, undefined);
  assert.equal(requests[0].request.runtimeLimits.runTimeoutMs, 2000);
  assert.equal(requests[0].request.controlInstructions, "");
});

test("register and submit reject legacy contracts and unsupported trusted Context paths", async () => {
  const { engine, store } = capturingEngine();
  await assert.rejects(engine.registerAgent({ agentSource: "provisioned", name: "legacy", adapterType: "test", config: {} }), /LEGACY_AGENT_CONTRACT_REJECTED/);
  await assert.rejects(engine.registerAgent({ agentSource: "provisioned", name: "missing" }), /CONTEXT_REQUIRED/);
  for (const config of [{ autoApprove: false }, { dangerouslyBypassPermissions: false }, { permissionMode: "default" }, { sandbox: "read-only" }]) {
    await assert.rejects(engine.registerAgent({ agentSource: "provisioned", name: "permissions", defaultContext: defaultContext(), config }), /LEGACY_PERMISSION_CONFIG_REJECTED/);
  }
  await assert.rejects(engine.registerAgent({ agentSource: "provisioned", name: "config", defaultContext: defaultContext(), config: { model: "legacy" } }), /LEGACY_AGENT_CONFIG_REJECTED/);
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "supported", defaultContext: defaultContext() });
  const missing = submission(agent.id);
  delete missing.context;
  await assert.rejects(engine.submitAgentRun(missing), /CONTEXT_REQUIRED/);
  await assert.rejects(engine.submitAgentRun({ ...submission(agent.id), approvalMode: "full_access" }), /LEGACY_RUN_CONTRACT_REJECTED/);
  for (const item of [
    { namespace: "octo.control", name: "instructions", payload: { entries: [{ text: "trusted?", source: "agent_configuration" }] } },
    { namespace: "octo.content", name: "resources", payload: { entries: [] } },
    { namespace: "octo.runtime", name: "selection", payload: { mode: "explicit", runtime_id: "remote" } }
  ]) {
    const context = { schema: "octo.context-envelope/v1", items: [item] };
    await assert.rejects(engine.submitAgentRun(submission(agent.id, "unsupported", context)), /LOCAL_CONTEXT_TYPE_UNSUPPORTED/);
    await assert.rejects(engine.registerAgent({ agentSource: "provisioned", name: "unsupported", defaultContext: { ...defaultContext(), items: [...defaultContext().items, item] } }), /LOCAL_CONTEXT_TYPE_UNSUPPORTED/);
  }
  assert.equal(store.listAgentRuns().length, 0);
  assert.equal(store.listAgentSessions().length, 0);
});

test("stable provider materialization cannot silently transfer to another Adapter", async () => {
  const { engine, store } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "bound", defaultContext: defaultContext(), config: { providerAgentId: "test-agent" } });
  const context = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.execution", name: "adapter", payload: { type: "other" } }] };
  await assert.rejects(engine.submitAgentRun(submission(agent.id, "other", context)), /LOCAL_MATERIALIZATION_ADAPTER_MISMATCH/);
  assert.equal(store.listAgentRuns().length, 0);
});

test("compatible successive Runs reuse their Provider session", async () => {
  const { engine, requests } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "resume", defaultContext: defaultContext() });
  const first = await engine.submitAgentRun(submission(agent.id, "first"));
  await engine.executeRun(first.agentRun.id);
  const next = await engine.submitAgentRun(submission(agent.id, "next"));
  await engine.executeRun(next.agentRun.id);
  assert.equal(requests[1].request.providerSession.sessionId, `provider-${first.agentRun.id}`);
});

test("local text parts remain user input and never become control instructions", async () => {
  const { engine, requests } = capturingEngine();
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "parts", defaultContext: defaultContext("ask") });
  const result = await engine.submitAgentRun({ ...submission(agent.id), input: { parts: [{ type: "text", text: "Untrusted instruction" }] } });
  await engine.executeRun(result.agentRun.id);
  assert.equal(requests[0].request.modelInput, "Untrusted instruction");
  assert.equal(requests[0].request.controlInstructions, "");
});

test("registered Adapter submissions and occurrence replay do not require a live Host", async () => {
  let available = true;
  const store = new MemoryStore();
  const host = {
    list: () => {
      if (!available) throw Object.assign(new Error("restarting"), { code: "ADAPTER_HOST_RESTARTING" });
      return [{ type: "test" }, { type: "other" }];
    }
  };
  const engine = new HarnessEngine({ store, host });
  const agent = await engine.registerAgent({ agentSource: "provisioned", name: "offline", defaultContext: defaultContext() });
  const first = await engine.submitAgentRun(submission(agent.id, "first"));
  available = false;
  const duplicate = await engine.submitAgentRun(submission(agent.id, "first"));
  assert.equal(duplicate.agentRun.id, first.agentRun.id);
  assert.equal(duplicate.deduplicated, true);
  const next = await engine.submitAgentRun(submission(agent.id, "next"));
  assert.equal(next.agentRun.status, "queued");
  const override = { schema: "octo.context-envelope/v1", items: [{ namespace: "octo.execution", name: "adapter", payload: { type: "other" } }] };
  await assert.rejects(engine.submitAgentRun(submission(agent.id, "override", override)), error => error.code === "ADAPTER_HOST_RESTARTING");
  assert.equal(store.listAgentRuns().length, 2);
});
