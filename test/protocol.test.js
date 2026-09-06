import test from "node:test";
import assert from "node:assert/strict";
import {
  assertCanonicalEvent,
  assertChannelContextAppend,
  assertChannelContextDescriptor,
  assertContextSyncResult,
  messageExposure
} from "../packages/octo-harness-protocol/dist/index.js";

test("analysis exposure defaults closed and public classifications require provenance", () => {
  const legacy = {
    type: "message.delta",
    payload: { channel: "analysis", text: "unclassified" }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(legacy));
  assert.equal(messageExposure(legacy), "unknown");

  const summary = {
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

  assert.throws(
    () => assertCanonicalEvent({
      type: "message.delta",
      payload: { channel: "analysis", text: "unsafe", exposure: "public_summary" }
    }),
    /requires payload\.provenance/
  );
  assert.throws(
    () => assertCanonicalEvent({
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
    scope: { ...scope, channel: "" }, facts: [trigger]
  }), /scope.channel/);
  assert.throws(() => assertChannelContextAppend({ scope, facts: [] }), /1\.\.100/);
  assert.throws(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 1,
    trigger_message_id: trigger.message_id, trigger_fact: trigger
  }), /must match trigger_seq/);
  assert.throws(() => assertChannelContextDescriptor({
    scope, consumer_key: "agent/provider", session_generation: 0,
    trigger_message_id: trigger.message_id, trigger_seq: 2, trigger_fact: trigger
  }), /session_generation/);
  assert.throws(() => assertChannelContextAppend({
    scope, facts: [{ ...trigger, sender: { id: "member-1" } }]
  }), /sender.kind/);
  assert.throws(() => assertChannelContextAppend({
    scope, facts: [{ ...trigger, occurred_at_ms: 0 }]
  }), /occurred_at_ms/);
  assert.throws(() => assertChannelContextAppend({
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
  const codex = {
    type: "tool_call.create",
    payload: { id: "tool-codex", name: "exec_command", args: { command: "pwd", cwd: "/repo" } }
  };
  assert.doesNotThrow(() => assertCanonicalEvent(codex));
  assert.equal(codex.payload.args.command, "pwd");

  const claude = [
    { type: "tool_call.create", payload: { id: "tool-claude", name: "Bash", args: {} } },
    { type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: '{"command":"printf ' } },
    { type: "tool_call.delta", payload: { id: "tool-claude", argsDelta: 'octo-harness-ok"}' } },
    { type: "tool_call.update", payload: { id: "tool-claude", status: "completed", output: "octo-harness-ok" } }
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
    () => assertCanonicalEvent({ type: "tool_call.create", payload: { id: "tool-1", name: "Bash" } }),
    /payload\.args must be an object/
  );
  assert.throws(
    () => assertCanonicalEvent({ type: "tool_call.delta", payload: { id: "tool-1" } }),
    /requires argsDelta or outputDelta/
  );
  assert.throws(
    () => assertCanonicalEvent({ type: "tool_call.update", payload: { id: "tool-1" } }),
    /payload\.status must be a non-empty string/
  );
});
