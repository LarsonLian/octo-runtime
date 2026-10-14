import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawAdapter } from "@mininglamp-oss/octo-runtime-adapter-openclaw";

test("OpenClaw Gateway preserves new thought phases, native answer IDs and commentary snapshots", async () => {
  let listener;
  const client = {
    connect: async () => ({ protocol: 4, features: { methods: ["agents.list", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"], events: ["agent"] } }),
    onEvent(fn) { listener = fn; return () => {}; }, close: async () => {},
    async request(method, params, options = {}) {
      if (method === "agents.list") return { agents: [{ id: "runner" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method !== "agent") return { status: "ok" };
      const runId = params.idempotencyKey;
      options.onAccepted?.({ runId });
      const events = [
        ["thinking", { text: "thought A" }],
        ["tool", { phase: "start", toolCallId: "t", name: "read", args: {} }],
        ["tool", { phase: "result", toolCallId: "t", name: "read", result: "ok" }],
        ["thinking", { text: "thought B" }],
        ["thinking", { text: "replacement B" }],
        ["item", { kind: "preamble", itemId: "preamble", progressText: "checking", phase: "update" }],
        ["item", { kind: "preamble", itemId: "preamble", progressText: "checking files", phase: "end" }],
        ["assistant", { itemId: "answer-1", text: "first answer" }],
        ["assistant", { itemId: "answer-2", text: "second answer" }],
        ["lifecycle", { phase: "end" }]
      ];
      events.forEach(([stream, data], index) => listener({ event: "agent", payload: { runId, seq: index + 1, stream, data } }));
      return { status: "ok" };
    }
  };
  const adapter = createOpenClawAdapter({ clientFactory: () => client });
  const output = [];
  for await (const e of adapter.invoke({ protocolVersion: 2, invocationId: "i", agentSessionId: "s", runId: "r", prompt: "p", modelInput: "p", workdir: process.cwd(), context: { schema: "octo.context-envelope/v3", items: [] }, controlInstructions: "", approvalMode: "full_access", agentSource: "provisioned", agentConfig: { providerAgentId: "runner", providerOptions: { OPENCLAW_GATEWAY_URL: "ws://localhost:1", OPENCLAW_GATEWAY_TOKEN: "fixture", OPENCLAW_GATEWAY_DEVICE_ID: "fixture", OPENCLAW_GATEWAY_PUBLIC_KEY: "fixture", OPENCLAW_GATEWAY_PRIVATE_KEY: "fixture" } } })) output.push(e);
  const thoughts = output.filter(e => e.type.startsWith("message.") && e.payload.channel === "analysis" && e.payload.text);
  assert.notEqual(thoughts[0].payload.messageId, thoughts[1].payload.messageId);
  assert.equal(thoughts[1].payload.messageId, thoughts[2].payload.messageId);
  assert.equal(thoughts[2].type, "message.update");
  assert.equal(thoughts[2].payload.status, "streaming");
  const commentary = output.filter(e => e.payload.channel === "commentary");
  assert.deepEqual(commentary.map(e => e.type), ["message.update", "message.update"]);
  assert.equal(commentary[0].payload.messageId, commentary[1].payload.messageId);
  const answers = output.filter(e => e.type === "message.delta" && e.payload.channel === "final");
  assert.notEqual(answers[0].payload.messageId, answers[1].payload.messageId);
  assert.equal(output.at(-1).type, "run.completed");
});
