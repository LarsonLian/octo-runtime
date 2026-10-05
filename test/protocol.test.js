import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalEvent,
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult,
  assertInteractionResponse,
  messageExposure
} from "../packages/octo-harness-protocol/dist/index.js";

test("interaction contracts require a stable request id and bounded response outcome", () => {
  assert.doesNotThrow(() => assertCanonicalEvent({ protocolVersion: 2,
    type: "interaction.requested",
    payload: {
      interactionId: "approval-1",
      kind: "approval",
      request: { title: "Run tests", command: "pnpm test" }
    }
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
