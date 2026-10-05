import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createZcodeGuiAdapter,
  discoverZcodeBin,
  ZcodeEventNormalizer
} from "@mininglamp-oss/octo-harness-adapter-zcode-gui";

const fixture = fileURLToPath(new URL("../test-support/zcode/fake-zcode-app-server.js", import.meta.url));

function request(agentConfig = {}, providerSession) {
  return { protocolVersion: 2,
    invocationId: "inv-zcode",
    agentSessionId: "agent-session-zcode",
    runId: "run-zcode",
    prompt: "write a file",
    workdir: process.cwd(),
    context: {},
    appendInstructions: "CONTROL",
    agentConfig,
    ...(providerSession ? { providerSession } : {})
  };
}

async function invoke(agentConfig = {}, providerSession) {
  const adapter = createZcodeGuiAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const events = [];
  for await (const event of adapter.invoke(request(agentConfig, providerSession))) events.push(event);
  return events;
}

test("ZCode GUI adapter discovers an explicit desktop CLI", () => {
  assert.equal(discoverZcodeBin({ ZCODE_BIN: fixture, PATH: "" }), fixture);
});

test("ZCode GUI adapter answers runtime preferences, streams events, and auto-approves explicitly", async () => {
  const events = await invoke({ autoApprove: true });
  assert.equal(events[0].type, "session.update");
  assert.equal(events[0].payload.providerSession.sessionId, "sess-zcode-fixture");
  assert.equal(events.find(event => event.type === "message.delta" && event.payload.channel === "final")?.payload.text, "permission:allow");
  assert.deepEqual(
    events.filter(event => event.type.startsWith("tool_call.")).map(event => [event.type, event.payload.status]),
    [
      ["tool_call.create", "running"],
      ["tool_call.update", "completed"]
    ]
  );
  assert.equal(events.at(-1).type, "run.completed");
});

test("ZCode GUI adapter denies native tool permission by default", async () => {
  const events = await invoke({ permissionMode: "build" });
  assert.equal(events.find(event => event.type === "message.delta" && event.payload.channel === "final")?.payload.text, "permission:deny");
  assert.equal(events.at(-1).type, "run.completed");
});

test("ZCode GUI adapter falls back to a fresh session after resume failure", async () => {
  const events = await invoke({ autoApprove: true }, { sessionId: "sess-missing" });
  assert.deepEqual(events[0].payload.providerSession, {
    sessionId: "sess-zcode-fixture",
    resumable: true,
    resumeOutcome: "fresh_fallback",
    resumeFallback: "rpc_404",
    contextInputVariant: "primary"
  });
  assert.equal(events.at(-1).type, "run.completed");
});

test("ZCode event normalizer ignores the duplicate turn.terminal compatibility event", () => {
  const normalizer = new ZcodeEventNormalizer("run-1");
  assert.deepEqual(normalizer.normalize({
    sessionId: "sess-1",
    seq: 1,
    type: "turn.terminal",
    payload: { status: "success" }
  }), []);
});
