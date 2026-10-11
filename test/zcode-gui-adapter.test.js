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
    modelInput: "write a file",
    workdir: process.cwd(),
    context: { schema: "octo.context-envelope/v3", items: [] },
    controlInstructions: "CONTROL",
    approvalMode: "full_access",
    agentConfig,
    ...(providerSession ? { providerSession } : {})
  };
}

async function invoke(agentConfig = {}, providerSession, context) {
  const adapter = createZcodeGuiAdapter({ command: process.execPath, appServerArgs: [fixture] });
  const events = [];
  for await (const event of adapter.invoke(request(agentConfig, providerSession), context)) events.push(event);
  return events;
}

test("ZCode GUI adapter discovers an explicit desktop CLI", () => {
  assert.equal(discoverZcodeBin({ ZCODE_BIN: fixture, PATH: "" }), fixture);
});

test("ZCode GUI adapter full_access answers runtime preferences, streams events, and uses native yolo", async () => {
  const observations = [];
  const events = await invoke({}, undefined, { observe: async observation => {
    observations.push(observation);
    return { captureId: "zcode-full-access", state: "accepted", complete: true };
  } });
  const create = observations.find(observation => observation.event === "provider.input" && observation.rpcMethod === "session/create");
  assert.equal(create.carrier.content.params.mode, "yolo");
  assert.equal(events.find(event => event.type === "session.update").payload.providerSession.sessionId, "sess-zcode-fixture");
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

test("ZCode GUI adapter rejects unqualified assisted before starting its native transport", async () => {
  let spawned = false;
  const adapter = createZcodeGuiAdapter({ spawnFn: () => { spawned = true; throw new Error("provider must not launch"); } });
  for (const approvalMode of ["assisted"]) {
    await assert.rejects(async () => {
      for await (const event of adapter.invoke({ ...request(), approvalMode })) assert.fail(`unexpected ${event.type}`);
    }, /APPROVAL_MODE_UNSUPPORTED/);
  }
  assert.equal(adapter.metadata.executionFeatures.includes("interaction.response"), true);
  assert.equal(spawned, false);
});

test("ZCode GUI adapter rejects explicit model before starting its native transport", async () => {
  let spawned = false;
  const adapter = createZcodeGuiAdapter({ spawnFn: () => { spawned = true; throw new Error("provider must not launch"); } });
  for (const agentConfig of [{ model: "requested-model" }]) {
    await assert.rejects(async () => {
      for await (const event of adapter.invoke(request(agentConfig))) assert.fail(`unexpected ${event.type}`);
    }, /EXECUTION_SELECTION_UNSUPPORTED/);
  }
  assert.equal(spawned, false);
});

test("ZCode GUI adapter falls back to a fresh session after resume failure", async () => {
  const events = await invoke({}, { sessionId: "sess-missing" });
  assert.deepEqual(events.find(event => event.type === "session.update").payload.providerSession, {
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

test("ZCode preserves requested effort and uses its native default with an explicit notice", async () => {
  const events = await invoke({ effort: "xhigh" });
  assert.equal(events[0].payload.params.warningCode, "REASONING_EFFORT_NOT_APPLIED");
  assert.equal(events.at(-1).type, "run.completed");
});
