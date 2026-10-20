import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { InvocationExperience } from "../packages/octo-runtime-executor-core/dist/experience.js";
import { AdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";

const metadata = {
  messageId: "thought",
  channel: "analysis",
  exposure: "public_reasoning",
  provenance: { provider: "fixture", nativeEvent: "thought" }
};
test("streaming message snapshots keep one activity until an explicit terminal", () => {
  const experience = new InvocationExperience();
  experience.start();
  const start = experience.accept({
    protocolVersion: 2,
    type: "message.create",
    payload: { ...metadata, status: "streaming" }
  });
  assert.equal(
    start.filter((e) => e.type === "activity.started" && e.payload.kind === "thinking").length,
    1
  );
  for (const text of ["first", "replacement", "replacement"]) {
    const events = experience.accept({
      protocolVersion: 2,
      type: "message.update",
      payload: { ...metadata, status: "streaming", text }
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["message.update"]
    );
  }
  const end = experience.accept({
    protocolVersion: 2,
    type: "message.update",
    payload: { ...metadata, status: "stopped" }
  });
  assert.equal(end[0].type, "activity.finished");
  assert.equal(end[0].payload.status, "cancelled");
});

test("Host closes a still-streaming snapshot on root completion", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: {
      protocolSupport: {
        protocol: "snapshot" + ".canonical",
        modes: ["canonical"],
        nativeMethods: []
      },
      type: "snapshot",
      agentSources: ["provisioned"]
    },
    async *invoke() {
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: { ...metadata, status: "streaming", text: "public snapshot" }
      };
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    }
  });
  const events = [];
  for await (const event of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "snapshot",
    {
      protocolVersion: 2,
      invocationId: "i",
      agentSessionId: "s",
      runId: "r",
      prompt: "p",
      modelInput: "p",
      workdir: process.cwd(),
      context: { schema: "octo.context-envelope/v3", items: [] },
      controlInstructions: "",
      approvalMode: "full_access",
      agentSource: "provisioned",
      agentConfig: {}
    },
    { protocolMode: "canonical" }
  ))
    events.push(event);
  assert.deepEqual(
    events.filter((e) => e.type === "message.update").map((e) => e.payload.status),
    ["streaming", "completed"]
  );
  assert.equal(
    events.filter((e) => e.type === "activity.started" && e.payload.kind === "thinking").length,
    1
  );
  assert.equal(events.at(-1).type, "run.completed");
});
