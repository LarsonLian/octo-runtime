import test from "node:test";
import assert from "node:assert/strict";
import { AdapterHost } from "../packages/octo-harness-adapter-host/dist/index.js";

test("Host scopes anonymous segments to tool boundaries and closes every channel at a step end", async () => {
  const host = new AdapterHost();
  host.register({ metadata: { type: "identity", capabilities: [], agentSources: ["provisioned"], executionFeatures: ["approval.ask", "approval.assisted", "approval.full_access"] }, async *invoke() {
    const event = (type, payload) => ({ protocolVersion: 2, type, payload });
    yield event("message.create", { status: "streaming" });
    yield event("message.delta", { text: "before" });
    yield event("message.delta", { text: " continued" });
    yield event("tool_call.create", { id: "tool", name: "read", args: {}, status: "running" });
    yield event("tool_call.update", { id: "tool", status: "completed" });
    yield event("message.delta", { text: "after", stepId: "next" });
    yield event("model_step.finished", { stepId: "next", status: "completed" });
    yield event("message.update", { status: "completed" });
    yield event("run.completed", {});
  } });
  const events = [];
  for await (const e of host.invoke("identity", { protocolVersion: 2, invocationId: "i", agentSessionId: "s", runId: "r", prompt: "p", modelInput: "p", workdir: process.cwd(), context: { schema: "octo.context-envelope/v3", items: [] }, controlInstructions: "", approvalMode: "full_access", agentSource: "provisioned", agentConfig: {} })) events.push(e);
  const deltas = events.filter(e => e.type === "message.delta");
  assert.equal(deltas[0].payload.messageId, deltas[1].payload.messageId);
  assert.notEqual(deltas[0].payload.messageId, deltas[2].payload.messageId);
  assert.equal(events.filter(e => e.type === "message.create").length, 2);
  const updates = events.filter(e => e.type === "message.update");
  assert.equal(updates.length, 2);
  assert.ok(events.indexOf(updates[1]) < events.findIndex(e => e.type === "model_step.finished"));
});
