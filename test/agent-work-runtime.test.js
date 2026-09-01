import test from "node:test";
import assert from "node:assert/strict";
import {
  accumulateFinalText,
  mapExecutionEnvelope,
  mapRuntimeEvent,
  renderImmutableExecutionInputPrompt
} from "../apps/daemon/dist/agent-work-runtime.js";

const envelope = {
  schema_version: 1,
  run_id: "run-1",
  harness_session_id: "chat-1",
  provider_session: { sessionId: "thread-previous", resumable: true },
  execution_request: {
    id: "exec-1",
    agent_id: "agent-1",
    agent_revision_id: "revision-1",
    source_type: "chat_turn",
    source_id: "turn-1"
  },
  agent_revision: {
    definition: { instructions: "Keep changes scoped." },
    execution_profile: {
      default_adapter: "codex-local",
      workdir: "/workspace/project",
      agent_config: { sandbox: "workspace-write", model: "gpt-5" }
    }
  },
  immutable_execution_input: {
    content: {
      parts: [{ type: "text", text: "Fix the test" }],
      reply_to: { author_name: "Ada", text: "The failing case is reset." },
      context_refs: [{
        kind: "recent_group",
        messages: [{ author_name: "Lin", text: "Use the existing adapter." }]
      }]
    }
  }
};

test("Agent Work envelope maps to a local adapter invocation with fixed cwd and resume", () => {
  const mapped = mapExecutionEnvelope(envelope);
  assert.equal(mapped.adapterType, "codex");
  assert.equal(mapped.request.sessionId, "chat-1");
  assert.equal(mapped.request.workdir, "/workspace/project");
  assert.equal(mapped.request.providerSession.sessionId, "thread-previous");
  assert.equal(mapped.request.agentConfig.sandbox, "workspace-write");
  assert.match(mapped.request.prompt, /\[Recent group messages\]/);
  assert.match(mapped.request.prompt, /\[Quoted message from Ada\]/);
  assert.match(mapped.request.prompt, /\[Current message\]\nFix the test/);
});

test("immutable execution input rendering keeps background separate from the current message", () => {
  const prompt = renderImmutableExecutionInputPrompt(envelope.immutable_execution_input.content);
  assert.ok(prompt.indexOf("Recent group messages") < prompt.indexOf("Current message"));
});

test("runtime terminal mapping carries the assembled final answer", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: {} }, "done"), {
    type: "run.completed",
    payload: { text: "done" }
  });
  assert.equal(mapRuntimeEvent({ type: "run.stopped", payload: { reason: "cancelled" } }, "").type, "run.cancelled");
});

test("final answer accumulator replaces snapshots and appends deltas", () => {
  let text = accumulateFinalText("", {
    type: "message.delta",
    payload: { channel: "final", text: "part" }
  });
  text = accumulateFinalText(text, {
    type: "message.update",
    payload: { channel: "final", text: "complete answer", replace: true }
  });
  text = accumulateFinalText(text, {
    type: "message.delta",
    payload: { channel: "analysis", text: "private reasoning" }
  });
  assert.equal(text, "complete answer");
});

test("terminal mapping uses provider terminal text when no message frame carried final text", () => {
  assert.deepEqual(mapRuntimeEvent({ type: "run.finished", payload: { text: "provider answer" } }, ""), {
    type: "run.completed",
    payload: { text: "provider answer" }
  });
});
