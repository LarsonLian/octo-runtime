import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalEvent,
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult,
  assertInteractionResponse,
  assertContextEnvelope,
  assertInvokeRequest,
  assertResolvedExecutionPlan,
  messageExposure
} from "../packages/octo-harness-protocol/dist/index.js";
import { approvalPayload, contextEnvelope, continuityItem, executionContext, invokeRequest } from "./agent-work-runtime-fixture.js";

test("interaction contracts require a stable request id and bounded response outcome", () => {
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2,
    type: "interaction.requested",
    payload: approvalPayload("invoke-approval")
  }));
  assert.doesNotThrow(() => assertInteractionResponse({
    interactionId: "approval-1", outcome: "accepted"
  }));
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: { kind: "approval", request: {} } }),
    /payload\.interactionId/
  );
  assert.throws(
    () => assertInteractionResponse({ interactionId: "approval-1", outcome: "maybe" }),
    /outcome is unsupported/
  );
});

test("InvokeRequest requires structured Context, control instructions, model input, and explicit approval mode", () => {
  const request = invokeRequest();
  assert.doesNotThrow(() => assertInvokeRequest(request));
  for (const [field, error] of [
    ["context", /CONTEXT_REQUIRED/],
    ["controlInstructions", /controlInstructions must be a string/],
    ["modelInput", /modelInput must be a non-empty string/],
    ["approvalMode", /APPROVAL_MODE_UNSUPPORTED/]
  ]) {
    const incomplete = { ...request };
    delete incomplete[field];
    assert.throws(() => assertInvokeRequest(incomplete), error);
  }
  for (const modelInput of ["", null, 42]) {
    assert.throws(() => assertInvokeRequest({ ...request, modelInput }), /modelInput must be a non-empty string/);
  }
  for (const controlInstructions of [null, 42]) {
    assert.throws(() => assertInvokeRequest({ ...request, controlInstructions }), /controlInstructions must be a string/);
  }
  assert.doesNotThrow(() => assertInvokeRequest({ ...request, controlInstructions: "" }));
  for (const approvalMode of ["ask", "assisted", "full_access"]) {
    assert.doesNotThrow(() => assertInvokeRequest({ ...request, approvalMode }));
  }
  for (const approvalMode of ["auto", "never", "", null]) {
    assert.throws(() => assertInvokeRequest({ ...request, approvalMode }), /APPROVAL_MODE_UNSUPPORTED/);
  }
});

test("InvokeRequest rejects legacy instruction and permission fields rather than falling back", () => {
  const request = invokeRequest();
  for (const appendInstructions of ["legacy", "", undefined]) {
    assert.throws(() => assertInvokeRequest({ ...request, appendInstructions }), /LEGACY_RUN_CONTRACT_REJECTED/);
  }
  for (const agentConfig of [{ autoApprove: true }, { autoApprove: false }, { dangerouslyBypassPermissions: true }, { permissionMode: "default" }]) {
    assert.throws(() => assertInvokeRequest({ ...request, agentConfig }), /LEGACY_PERMISSION_CONFIG_REJECTED/);
  }
});

test("audit metadata belongs in runMetadata and is not an alternate Context contract", () => {
  const runMetadata = { namespace: "im", agentId: "agent-1", profile: "work", runtimeId: "runtime-1" };
  assert.doesNotThrow(() => assertInvokeRequest(invokeRequest({ context: contextEnvelope(), runMetadata })));
  for (const context of [{}, runMetadata, { ...contextEnvelope(), ...runMetadata }]) {
    assert.throws(() => assertInvokeRequest(invokeRequest({ context })), /CONTEXT_SCHEMA_INVALID/);
  }
});

test("resolved execution plan requires frozen execution selection and rejects revision-shaped fallbacks", () => {
  const plan = { adapter_type: "codex", workdir: "/workspace", approval_mode: "ask", model: "frozen-model" };
  assert.doesNotThrow(() => assertResolvedExecutionPlan(plan));
  for (const value of [undefined, null]) {
    assert.throws(() => assertResolvedExecutionPlan(value), /RESOLVED_EXECUTION_PLAN_REQUIRED/);
  }
  assert.throws(() => assertResolvedExecutionPlan({ default_adapter: "codex", workdir: "/workspace", approval_mode: "ask" }), /CONTEXT_SCHEMA_INVALID/);
  assert.throws(() => assertResolvedExecutionPlan({ ...plan, agent_config: { model: "legacy" } }), /CONTEXT_SCHEMA_INVALID/);
  const { approval_mode, ...withoutApprovalMode } = plan;
  assert.throws(() => assertResolvedExecutionPlan(withoutApprovalMode), /APPROVAL_MODE_UNSUPPORTED/);
});

test("execution Context fixtures carry explicit frozen selections and provider defaults without sharing plan objects", () => {
  const plan = {
    adapter_type: "codex", workdir: "/workspace", approval_mode: "ask",
    model: "frozen-model", effort: "high", runtime_limits: { run_timeout_ms: 60_000 }
  };
  const context = executionContext(plan);
  assert.doesNotThrow(() => assertContextEnvelope(context));
  assert.deepEqual(context.items.find(item => item.name === "adapter").payload, { type: "codex" });
  assert.deepEqual(context.items.find(item => item.name === "workspace").payload, { mode: "fixed", path: "/workspace" });
  assert.deepEqual(context.items.find(item => item.name === "approval_policy").payload, { mode: "ask" });
  assert.deepEqual(context.items.find(item => item.name === "model").payload, { id: "frozen-model" });
  assert.deepEqual(context.items.find(item => item.name === "reasoning").payload, { effort: "high" });
  context.items.find(item => item.name === "limits").payload.run_timeout_ms = 120_000;
  assert.equal(plan.runtime_limits.run_timeout_ms, 60_000);
  const providerDefaults = executionContext({ adapter_type: "codex", workdir: "/workspace", approval_mode: "ask" });
  assert.doesNotThrow(() => assertContextEnvelope(providerDefaults));
  for (const name of ["model", "reasoning"]) {
    assert.deepEqual(providerDefaults.items.find(item => item.name === name).payload, { use_provider_default: true });
  }
});

test("typed content selections, continuity and sourced instructions have bounded entry shapes", () => {
  const items = [
    { namespace: "octo.content", name: "selections", payload: { entries: [{ resource_ref: "octo://messages/selected", text: "Selected message" }] } },
    { namespace: "octo.control", name: "instructions", payload: { entries: [{ text: "Keep changes scoped.", source: "platform_policy" }] } },
    continuityItem()
  ];
  assert.doesNotThrow(() => assertContextEnvelope(contextEnvelope(items)));
  for (const entry of [{ text: "legacy instruction" }, { source: "revision" }, { text: "control", source: 42 }, { text: "control", source: "revision", command: "legacy" }]) {
    assert.throws(() => assertContextEnvelope(contextEnvelope([{
      namespace: "octo.control", name: "instructions", payload: { entries: [entry] }
    }])), /CONTEXT_SCHEMA_INVALID/);
  }
  for (const entry of [{}, { text: 42 }, { resource_ref: "octo://selected", messages: [] }]) {
    assert.throws(() => assertContextEnvelope(contextEnvelope([{
      namespace: "octo.content", name: "selections", payload: { entries: [entry] }
    }])), /CONTEXT_SCHEMA_INVALID/);
  }
});

test("canonical interactions carry instance-scoped expiry and distinct resolved lifecycle events", () => {
  const payload = approvalPayload("invoke-approval");
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload }));
  for (const status of ["resolved", "expired", "invalidated"]) {
    assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.resolved", payload: {
      interactionId: payload.interactionId,
      executionInstanceId: payload.executionInstanceId,
      status,
      ...(status === "resolved" ? { outcome: "accepted" } : { reasonCode: status === "expired" ? "approval_timeout" : "execution_lost" })
    } }));
  }
});

test("every requested interaction requires a bounded execution instance and finite expiry", () => {
  for (const kind of ["approval", "question", "elicitation"]) {
    const payload = { ...approvalPayload("invoke-contract"), kind };
    assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload }));
    for (const expiresAt of ["2030-10-06T12:00:00.123456789Z", "2030-10-06T12:00:00+08:00"]) {
      assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: { ...payload, expiresAt } }));
    }
    for (const field of ["interactionId", "executionInstanceId", "expiresAt"]) {
      const incomplete = { ...payload };
      delete incomplete[field];
      assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: incomplete }), new RegExp(`payload\\.${field}`));
      assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: { ...payload, [field]: "" } }), new RegExp(`payload\\.${field}`));
    }
    for (const invalid of [
      { interactionId: "x".repeat(192) }, { executionInstanceId: "x".repeat(192) },
      ...["forever", "October 6, 2030", "2030-10-06", "2030-02-30T12:00:00Z", "2030-10-06T24:00:00Z", "2030-10-06T12:00:00+24:00"].map(expiresAt => ({ expiresAt }))
    ]) {
      assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: { ...payload, ...invalid } }), /instance or expiry is invalid/);
    }
  }
});

test("approval requests reject legacy flat objects and incomplete typed requests", () => {
  const payload = approvalPayload("invoke-contract");
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: {
    ...payload, request: { title: "Run tests", command: "pnpm test" }
  } }), /INVALID_APPROVAL_REQUEST/);
  for (const field of ["schema", "policy", "operation", "requestedPermissions", "allowedOutcomes", "grantScope"]) {
    const request = structuredClone(payload.request);
    delete request[field];
    const error = field === "grantScope" ? /APPROVAL_GRANT_SCOPE_UNSUPPORTED/ : /INVALID_APPROVAL_REQUEST/;
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.requested", payload: { ...payload, request } }), error, field);
  }
});

test("resolved interactions require instance identity and either an outcome or an invalidation reason", () => {
  const payload = { interactionId: "interaction-contract", executionInstanceId: "invoke-contract", status: "resolved", outcome: "accepted" };
  for (const field of ["interactionId", "executionInstanceId"]) {
    const incomplete = { ...payload };
    delete incomplete[field];
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.resolved", payload: incomplete }), new RegExp(`payload\\.${field}`));
  }
  for (const status of [undefined, "pending", "completed"]) {
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.resolved", payload: { ...payload, status } }), /payload\.status is invalid/);
  }
  for (const outcome of [undefined, "maybe"]) {
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.resolved", payload: { ...payload, outcome } }), /payload\.outcome is invalid/);
  }
  for (const status of ["expired", "invalidated"]) {
    assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "interaction.resolved", payload: { ...payload, status } }), /payload\.reasonCode/);
  }
});

test("analysis exposure defaults closed and public classifications require provenance", () => {
  const legacy = { protocolVersion: 2,
    type: "message.delta",
    payload: { channel: "analysis", text: "unclassified" }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(legacy));
  assert.equal(messageExposure(legacy), "unknown");

  const summary = { protocolVersion: 2,
    type: "message.delta",
    payload: {
      channel: "analysis",
      text: "Checked the source.",
      exposure: "public_summary",
      provenance: { provider: "codex", nativeEvent: "item/reasoning/summaryTextDelta" }
    }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(summary));
  assert.equal(messageExposure(summary), "public_summary");

  const publicReasoning = { protocolVersion: 2,
    type: "message.delta",
    payload: {
      channel: "analysis",
      text: "Inspecting the requested data.",
      exposure: "public_reasoning",
      provenance: { provider: "opencode", nativeEvent: "reasoning" }
    }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(publicReasoning));
  assert.equal(messageExposure(publicReasoning), "public_reasoning");

  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2,
      type: "message.delta",
      payload: { channel: "analysis", text: "unsafe", exposure: "public_summary" }
    }),
    /requires payload\.provenance/
  );
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2,
      type: "message.delta",
      payload: {
        channel: "analysis",
        text: "unsafe",
        exposure: "public_thought",
        provenance: { provider: "test", nativeEvent: "thought" }
      }
    }),
    /payload\.exposure is invalid/
  );
});

test("canonical message channels distinguish reasoning, progress, and answer content", () => {
  for (const channel of ["analysis", "commentary", "final"]) {
    const payload = channel === "analysis"
      ? { channel, exposure: "public_summary", provenance: { provider: "test", nativeEvent: "summary" } }
      : { channel };
    assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "message.update", payload }));
  }
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "message.update", payload: { channel: "provider-specific" } }),
    /payload\.channel/
  );
});

test("model step lifecycle requires stable identity and valid timestamps", () => {
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2,
    type: "model_step.started",
    payload: { stepId: "message-1", startedAtMs: 1_788_793_000_000 }
  }));
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2,
    type: "model_step.finished",
    payload: {
      stepId: "message-1", status: "completed", finishReason: "tool-calls",
      endedAtMs: 1_788_793_002_000
    }
  }));
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "model_step.started", payload: {} }),
    /payload\.stepId/
  );
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "model_step.finished", payload: { stepId: "message-1", status: "completed", endedAtMs: -1 } }),
    /payload\.endedAtMs/
  );
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "model_step.finished", payload: { stepId: "message-1", status: "completed", publicText: 42 } }),
    /payload\.publicText/
  );
});

test("channel context wire contracts reject incomplete scope and mismatched trigger facts", () => {
  const scope = {
    tenant_id: "tenant-1", endpoint_id: "endpoint-1", channel: "discord",
    account_id: null, bot_id: "bot-1", conversation_id: "conversation-1"
  };
  const trigger = {
    message_id: "message-2", message_seq: 2,
    sender: { id: "member-1", kind: "member" }, occurred_at_ms: 2,
    parts: [{ type: "text", text: "current" }]
  };
  assert.doesNotThrow(() => assertChannelContextAppend({
	agent_id: "agent-1",
    scope,
    facts: [{ ...trigger, message_id: "message-1", message_seq: 1 }]
  }));
  assert.doesNotThrow(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 1,
    trigger_message_id: "message-2", trigger_seq: 2, trigger_fact: trigger
  }));
  assert.throws(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 1,
    trigger_message_id: "different", trigger_seq: 2, trigger_fact: trigger
  }), /must match trigger_message_id/);
  assert.throws(() => assertChannelContextAppend({
	agent_id: "agent-1",
    scope: { ...scope, channel: "" }, facts: [trigger]
  }), /scope.channel/);
  assert.throws(() => assertChannelContextAppend({ agent_id: "agent-1", scope, facts: [] }), /1\.\.100/);
	assert.throws(() => assertChannelContextAppend({ scope, facts: [trigger] }), /agent_id/);
  assert.throws(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 1,
    trigger_message_id: trigger.message_id, trigger_fact: trigger
  }), /must match trigger_seq/);
  assert.throws(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 0,
    trigger_message_id: trigger.message_id, trigger_seq: 2, trigger_fact: trigger
  }), /session_generation/);
  assert.throws(() => assertChannelContextAppend({
	agent_id: "agent-1",
    scope, facts: [{ ...trigger, sender: { id: "member-1" } }]
  }), /sender.kind/);
  assert.throws(() => assertChannelContextAppend({
	agent_id: "agent-1",
    scope, facts: [{ ...trigger, occurred_at_ms: 0 }]
  }), /occurred_at_ms/);
  assert.throws(() => assertChannelContextAppend({
	agent_id: "agent-1",
    scope, facts: [{ ...trigger, parts: [] }]
  }), /at least one/);
  assert.throws(() => assertContextSyncResult({
    request_id: "sync-1", scope, facts: [trigger], completeness: "unavailable"
  }), /must not contain facts/);
  assert.doesNotThrow(() => assertContextSyncResult({
    request_id: "sync-2", scope, facts: [], completeness: "unavailable"
  }));
});

test("tool call protocol preserves complete and streamed command inputs", () => {
  const codex = { protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "tool-codex", name: "exec_command", args: { command: "pwd", cwd: "/repo" } }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(codex));
  assert.equal(codex.payload.args.command, "pwd");

  const claude = [
    { protocolVersion: 2, type: "tool_call.create", payload: { status: "running", id: "tool-claude", name: "Bash", args: {} } },
    { protocolVersion: 2, type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: '{"command":"printf ' } },
    { protocolVersion: 2, type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: 'octo-harness-ok"}' } },
    { protocolVersion: 2, type: "tool_call.update", payload: { id: "tool-claude", status: "completed", output: "octo-harness-ok" } }
  ];
  for (const event of claude) assert.doesNotThrow(() => assertCanonicalEvent(event));
  const streamedArgs = claude
    .filter(event => event.type === "tool_call.delta")
    .map(event => event.payload.argsDelta)
    .join("");
  assert.equal(JSON.parse(streamedArgs).command, "printf octo-harness-ok");
});

test("tool call protocol rejects events that cannot reconstruct a command lifecycle", () => {
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.create", payload: { status: "running", id: "tool-1", name: "Bash" } }),
    /payload\.args must be an object/
  );
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.delta", payload: { id: "tool-1" } }),
    /requires argsDelta, outputDelta or outputSnapshot/
  );
  assert.throws(
    () => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.update", payload: { id: "tool-1" } }),
    /payload\.status must be a non-empty string/
  );
});

test("protocol v2 rejects old roots and validates experience frames", () => {
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 1, type: "run.completed", payload: {} }), /protocolVersion/);
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "run.finished", payload: {} }), /unsupported/);
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2, type: "activity.started", payload: { activityId: "a", kind: "thinking", source: "provider", subject: { type: "run" }, info: {} } }));
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "tool_call.progress", payload: { id: "t", progress: { completed: 2, total: 1, unit: "steps" } } }));
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "plan.updated", payload: { planId: "p", revision: 0, explanation: null, steps: [] } }));
  assert.throws(() => assertCanonicalEvent({ protocolVersion: 2, type: "run.notice", payload: { noticeId: "n", code: "retry_scheduled", severity: "warning", params: { attempt: 2, error: "secret" } } }));
});
