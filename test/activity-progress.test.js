import test from "node:test";
import assert from "node:assert/strict";
import { InvocationExperience } from "../packages/octo-runtime-executor-core/dist/experience.js";
const event = (type, payload) => ({ protocolVersion: 2, type, payload });

test("session, usage and empty answer placeholders do not end starting", () => {
  const experience = new InvocationExperience();
  experience.start();
  for (const e of [
    event("session.update", {}),
    event("usage.update", {}),
    event("message.create", { messageId: "answer", channel: "final", status: "streaming" })
  ]) {
    assert.deepEqual(experience.accept(e), [e]);
  }
  const round = experience.accept(event("model_step.started", { stepId: "round" }));
  assert.ok(
    round.some((e) => e.type === "activity.finished" && e.payload.activityId === "harness:starting")
  );
  assert.ok(round.some((e) => e.type === "activity.started" && e.payload.kind === "working"));
  assert.ok(!round.some((e) => e.payload.kind === "thinking" || e.payload.kind === "responding"));
});

test("tool phases supersede prior thought activity and parallel tools close independently", () => {
  const experience = new InvocationExperience();
  experience.start();
  const thought = event("message.delta", {
    messageId: "thought",
    channel: "analysis",
    exposure: "public_reasoning",
    text: "public"
  });
  experience.accept(thought);
  const start = (id) =>
    experience.accept(event("tool_call.create", { id, name: "read", args: {}, status: "running" }));
  assert.ok(
    start("a").some(
      (e) => e.type === "activity.finished" && e.payload.activityId === "message:thought"
    )
  );
  start("b");
  const end = experience.accept(event("tool_call.update", { id: "a", status: "failed" }));
  assert.deepEqual(
    end.filter((e) => e.type === "activity.finished").map((e) => e.payload.activityId),
    ["tool:a"]
  );
  const resumed = experience.accept(thought);
  assert.ok(
    resumed.some(
      (e) => e.type === "activity.started" && e.payload.activityId === "message:thought:2"
    )
  );
  const terminal = experience.accept(event("run.completed", {}));
  assert.ok(
    terminal.some((e) => e.type === "activity.finished" && e.payload.activityId === "tool:b")
  );
  assert.deepEqual(experience.accept(thought), []);
  assert.deepEqual(experience.accept(event("run.completed", {})), []);
});
