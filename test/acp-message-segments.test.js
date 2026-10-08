import test from "node:test";
import assert from "node:assert/strict";
import { createAcpAdapter } from "@mininglamp-oss/octo-harness-adapter-acp";
import { createCodeBuddyAdapter } from "@mininglamp-oss/octo-harness-adapter-codebuddy";

for (const provider of ["ACP", "CodeBuddy"]) {
  test(`${provider}: text and thoughts retain segments across tool rounds`, async () => {
    let nextId = 0;
    const client = {
      initialize: async () => {}, reserveRequestId: () => ++nextId,
      request: async () => ({ sessionId: "test" }), close: async () => {}, cancel() {},
      async *prompt() {
        yield { sessionUpdate: "agent_thought_chunk", content: { text: "thought A" } };
        yield { sessionUpdate: "agent_message_chunk", content: { text: "before tool" } };
        yield { sessionUpdate: "tool_call", toolCallId: "t", name: "read", rawInput: {} };
        yield { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress", rawOutput: "reading" };
        yield { sessionUpdate: "tool_call_update", toolCallId: "t", status: "completed" };
        yield { sessionUpdate: "agent_thought_chunk", content: { text: "thought B" } };
        yield { sessionUpdate: "agent_message_chunk", content: { text: "answer" } };
        yield { sessionUpdate: "agent_message_chunk", content: { text: " continued" } };
        yield { type: "prompt_result", stopReason: "end_turn" };
      }
    };
    const adapter = provider === "ACP" ? createAcpAdapter({ type: "fixture", provider: "fixture", command: "fixture" }, { acpClientFactory: () => client }) : createCodeBuddyAdapter({ acpClientFactory: () => client });
    const request = { protocolVersion: 2, invocationId: "i", agentSessionId: "s", runId: "r", prompt: "p", modelInput: "p", workdir: process.cwd(), context: { schema: "octo.context-envelope/v1", items: [] }, controlInstructions: "", approvalMode: "full_access", agentSource: "provisioned", agentConfig: {} };
    const events = [];
    for await (const e of adapter.invoke(request)) events.push(e);
    const texts = events.filter(e => e.type === "message.delta");
    assert.equal(new Set(texts.slice(0, 4).map(e => e.payload.messageId)).size, 4);
    assert.ok(texts.every(e => e.payload.messageId && e.payload.stepId));
    assert.equal(texts[3].payload.messageId, texts[4].payload.messageId);
    assert.notEqual(texts[0].payload.stepId, texts[2].payload.stepId);
    assert.equal(events.filter(e => e.type === "model_step.started").length, 2);
    assert.equal(events.filter(e => e.type === "tool_call.update").length, 1);
    for (const id of new Set(texts.map(e => e.payload.messageId))) {
      assert.equal(events.filter(e => e.type === "message.update" && e.payload.messageId === id && e.payload.status === "completed").length, 1);
    }
    assert.equal(events.at(-1).type, "run.completed");
  });
}
