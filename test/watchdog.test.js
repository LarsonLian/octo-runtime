import { preparedFrames } from "./runtime-fixture.js";
import { preparedTestInvoke } from "./runtime-fixture.js";
import test from "node:test";
import assert from "node:assert/strict";
import { InvocationWatchdog } from "../packages/octo-runtime-executor-core/dist/watchdog.js";
import { AdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { assertRuntimeLimits } from "@mininglamp-oss/octo-runtime-protocol";

function fixture(limits = {}) {
  let now = 0;
  const timers = new Map();
  let id = 0;
  const clock = {
    now: () => now,
    schedule(fn, delay) {
      const key = ++id;
      timers.set(key, { fn, at: now + delay });
      return () => timers.delete(key);
    }
  };
  const controller = new AbortController();
  const records = [];
  const watchdog = new InvocationWatchdog(limits, controller, (r) => records.push(r), clock);
  return {
    watchdog,
    controller,
    records,
    timers,
    tick(ms) {
      const end = now + ms;
      while (true) {
        const first = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) break;
        now = first[1].at;
        timers.delete(first[0]);
        first[1].fn();
      }
      now = end;
    }
  };
}
const started = { kind: "turn_started", method: "turn_start" };
const progress = { kind: "turn_progress", method: "text_delta" };
const event = (type, payload = {}) => ({ protocolVersion: 2, type, payload });

test("canonical work rearms idle until valid native progress is observed", () => {
  const f = fixture({ firstFrameTimeoutMs: 500, modelIdleTimeoutMs: 100 });
  f.watchdog.canonical(event("message.delta", { text: "a" }));
  f.tick(80);
  f.watchdog.activity({ kind: "transport_response", method: "rpc_response" });
  f.watchdog.activity({ kind: "retry_notice", method: "retry" });
  f.watchdog.canonical(event("message.delta", { text: "b" }));
  f.tick(80);
  f.watchdog.canonical(event("message.delta", { text: "c" }));
  assert.equal(f.watchdog.snapshot().activitySupport, "canonical_only");
  f.tick(99);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.timeoutReason, "model_silence");
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 260);
});

test("late native start switches progress source without extending the existing idle budget", () => {
  const f = fixture({ firstFrameTimeoutMs: 500, modelIdleTimeoutMs: 100 });
  f.watchdog.canonical(event("message.delta", { text: "a" }));
  f.tick(80);
  f.watchdog.canonical(event("message.delta", { text: "b" }));
  f.tick(70);
  f.watchdog.activity(started);
  assert.equal(f.watchdog.snapshot().activitySupport, "native_progress");
  f.tick(20);
  f.watchdog.canonical(event("message.delta", { text: "c" }));
  f.tick(9);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 180);
});

test("native priority ignores canonical text while real native progress renews idle", () => {
  for (const nativeProgress of [false, true]) {
    const f = fixture({ modelIdleTimeoutMs: 100 });
    f.watchdog.activity(started);
    f.tick(90);
    f.watchdog.canonical(event("message.delta", { text: "canonical projection" }));
    if (nativeProgress) f.watchdog.activity(progress);
    f.tick(nativeProgress ? 99 : 9);
    assert.equal(f.controller.signal.aborted, false);
    f.tick(1);
    assert.equal(f.controller.signal.reason.evidence.elapsedMs, nativeProgress ? 190 : 100);
  }
});

test("invalid activity cannot switch sources, create tools, or close an active tool", () => {
  const f = fixture({ firstFrameTimeoutMs: 100 });
  for (const value of [
    { kind: "unknown", method: "item_lifecycle" },
    { kind: "turn_progress", method: "unknown" },
    { kind: "transport_response", method: "text_delta" },
    { kind: "turn_started", method: "rpc_response" },
    { kind: "retry_notice", method: "item_lifecycle" }
  ])
    f.watchdog.activity({ ...value, toolCallId: "forged", toolState: "started" });
  assert.equal(f.watchdog.snapshot().openToolCount, 0);
  assert.equal(f.watchdog.snapshot().activitySupport, "canonical_only");
  f.tick(100);
  assert.equal(f.controller.signal.reason.timeoutReason, "first_frame");
  const g = fixture({ toolTimeoutMs: 100 });
  g.watchdog.canonical(event("tool_call.create", { id: "a" }));
  g.tick(90);
  g.watchdog.activity({
    kind: "unknown",
    method: "item_lifecycle",
    toolCallId: "a",
    toolState: "completed"
  });
  assert.equal(g.watchdog.snapshot().openToolCount, 1);
  g.tick(10);
  assert.equal(g.controller.signal.reason.timeoutReason, "tool_idle");
});

test("canonical bookkeeping and empty placeholders cannot escape startup deadline", () => {
  const f = fixture({ firstFrameTimeoutMs: 100 });
  const records = [
    event("session.update"),
    event("usage.update"),
    event("run.notice"),
    event("execution.update"),
    event("message.create"),
    event("message.delta", { text: "" }),
    event("tool_call.delta", { id: "missing", outputDelta: "" }),
    event("tool_call.progress", { id: "missing", progress: {} })
  ];
  for (const record of records) {
    f.tick(10);
    f.watchdog.canonical(record);
  }
  assert.equal(f.watchdog.snapshot().phase, "starting");
  f.tick(20);
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 100);
  assert.equal(f.controller.signal.reason.timeoutReason, "first_frame");
});

test("canonical model steps and tool progress are real fallback work", () => {
  const f = fixture({ modelIdleTimeoutMs: 100 });
  f.watchdog.canonical(event("model_step.started", { stepId: "s" }));
  f.tick(90);
  f.watchdog.canonical(event("model_step.finished", { stepId: "s", status: "completed" }));
  f.tick(99);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 190);
  const g = fixture({ toolTimeoutMs: 100 });
  g.watchdog.canonical(event("tool_call.create", { id: "a" }));
  g.tick(90);
  g.watchdog.canonical(event("tool_call.progress", { id: "a", progress: { message: "working" } }));
  g.tick(99);
  assert.equal(g.controller.signal.aborted, false);
  g.tick(1);
  assert.equal(g.controller.signal.reason.evidence.elapsedMs, 190);
});

for (const native of [false, true]) {
  test(`approval priority survives new tools and multiple pending requests: native=${native}`, () => {
    const f = fixture({ toolTimeoutMs: 100, toolWallTimeoutMs: 200, runTimeoutMs: 1000 });
    f.watchdog.canonical(event("tool_call.create", { id: "old" }));
    f.tick(40);
    f.watchdog.interaction("a", true);
    f.watchdog.interaction("b", true);
    f.tick(300);
    if (native)
      f.watchdog.activity({
        kind: "turn_progress",
        method: "item_lifecycle",
        toolCallId: "new",
        toolState: "started"
      });
    else f.watchdog.canonical(event("tool_call.create", { id: "new" }));
    assert.equal(f.watchdog.snapshot().phase, "waiting_approval");
    f.tick(100);
    f.watchdog.interaction("a", false);
    assert.equal(f.watchdog.snapshot().phase, "waiting_approval");
    f.tick(100);
    f.watchdog.interaction("b", false);
    assert.equal(f.watchdog.snapshot().phase, "tool_active");
    f.tick(59);
    assert.equal(f.controller.signal.aborted, false);
    f.tick(1);
    assert.equal(f.controller.signal.reason.evidence.elapsedMs, 600);
    assert.equal(f.controller.signal.reason.timeoutReason, "tool_idle");
  });
}

test("tools created during approval receive only their overlapping wall-clock pause", () => {
  const f = fixture({ toolTimeoutMs: 1000, toolWallTimeoutMs: 200, runTimeoutMs: 1000 });
  f.watchdog.interaction("a", true);
  f.tick(300);
  f.watchdog.activity({
    kind: "turn_progress",
    method: "item_lifecycle",
    toolCallId: "new",
    toolState: "started"
  });
  f.tick(100);
  f.watchdog.interaction("a", false);
  f.tick(199);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 600);
  assert.equal(f.controller.signal.reason.timeoutReason, "tool_deadline");
});

test("model approval pause preserves its remaining idle budget and run deadline stays fixed", () => {
  const f = fixture({ modelIdleTimeoutMs: 100, runTimeoutMs: 1000 });
  f.watchdog.activity(started);
  f.tick(40);
  f.watchdog.interaction("a", true);
  f.tick(300);
  f.watchdog.interaction("a", false);
  f.tick(59);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.evidence.elapsedMs, 400);
  const g = fixture({ toolTimeoutMs: 100, runTimeoutMs: 500 });
  g.watchdog.interaction("a", true);
  g.tick(300);
  g.watchdog.activity({
    kind: "turn_progress",
    method: "item_lifecycle",
    toolCallId: "new",
    toolState: "started"
  });
  g.tick(200);
  assert.equal(g.controller.signal.reason.timeoutReason, "run_deadline");
  assert.equal(g.controller.signal.reason.evidence.elapsedMs, 500);
});

test(
  "late user cancellation cannot replace a terminal during cleanup",
  { timeout: 2000 },
  async () => {
    const host = new AdapterHost();
    let release, markCleaning;
    const cleaning = new Promise((resolve) => {
      markCleaning = resolve;
    });
    const cleanup = new Promise((resolve) => {
      release = resolve;
    });
    host.register({
      metadata: {
        protocolSupport: {
          protocol: "terminal-race" + ".canonical",
          modes: ["canonical"],
          nativeMethods: []
        },
        type: "terminal-race",
        agentSources: ["provisioned"]
      },
      async *invoke() {
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
        markCleaning();
        await cleanup;
      }
    });
    const stream = preparedTestInvoke((...args) => preparedFrames(host, ...args))(
      "terminal-race",
      { ...request, invocationId: "terminal-race" },
      { protocolMode: "canonical" }
    );
    const pending = (async () => {
      while (true) {
        const next = await stream.next();
        if (next.done || next.value.type.startsWith("run.")) return next;
      }
    })();
    await Promise.race([
      cleaning,
      pending.then(() => assert.fail("terminal delivered before cleanup"))
    ]);
    assert.equal(host.cancel("terminal-race"), false);
    release();
    assert.equal((await pending).value.type, "run.completed");
    await stream.next();
  }
);

test("session and usage records cannot escape startup deadline", () => {
  const f = fixture({ firstFrameTimeoutMs: 100 });
  f.tick(50);
  f.watchdog.canonical({ protocolVersion: 2, type: "session.update", payload: {} });
  f.tick(40);
  f.watchdog.canonical({ protocolVersion: 2, type: "usage.update", payload: {} });
  f.tick(10);
  assert.equal(f.controller.signal.reason.timeoutReason, "first_frame");
});

test("terminal freezes timers but completion metrics wait for cleanup outcome", () => {
  const f = fixture();
  f.watchdog.activity(started);
  f.tick(10);
  f.watchdog.canonical({ protocolVersion: 2, type: "run.completed", payload: {} });
  assert.equal(f.timers.size, 0);
  assert.equal(f.records.filter((x) => x.event === "finished").length, 0);
  f.tick(10000);
  f.watchdog.finish("failed");
  f.watchdog.finish("completed");
  const records = f.records.filter((x) => x.event === "finished");
  assert.equal(records.length, 1);
  assert.equal(records[0].data.outcome, "failed");
  assert.equal(records[0].data.elapsedMs, 10);
});

test("run defaults to three hours and explicit limits may shorten or extend it", () => {
  for (const [limits, deadline] of [
    [{}, 10_800_000],
    [{ runTimeoutMs: 7_200_000 }, 7_200_000],
    [{ runTimeoutMs: 21_600_000 }, 21_600_000]
  ]) {
    const f = fixture({ ...limits, modelIdlePolicy: "observe" });
    f.watchdog.activity(started);
    f.tick(deadline - 1);
    assert.equal(f.controller.signal.aborted, false);
    f.watchdog.activity(progress);
    f.tick(1);
    assert.equal(f.controller.signal.reason.timeoutMs, deadline);
    assert.equal(f.controller.signal.reason.timeoutReason, "run_deadline");
  }
});

test("default model budget tolerates 120 seconds and expires exactly at 300 seconds", () => {
  const f = fixture();
  f.watchdog.activity(started);
  f.tick(120_000);
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(f.records.filter((x) => x.event === "model_silence").length, 1);
  f.tick(179_999);
  assert.equal(f.controller.signal.aborted, false);
  f.tick(1);
  assert.equal(f.controller.signal.reason.timeoutReason, "model_silence");
  assert.equal(f.controller.signal.reason.timeoutMs, 300_000);
  assert.equal(f.timers.size, 0);
});

test("native progress rearms one timer, while transport and retries cannot hide model silence", () => {
  const f = fixture({ modelIdleTimeoutMs: 1000, modelIdleWarningMs: 500 });
  f.watchdog.activity(started);
  f.tick(600);
  f.watchdog.activity(progress);
  assert.equal(f.records.filter((x) => x.event === "progress_resumed").length, 1);
  for (let i = 0; i < 9; i++) {
    f.tick(100);
    f.watchdog.activity({ kind: "transport_response", method: "rpc_response" });
    f.watchdog.activity({ kind: "retry_notice", method: "retry" });
    assert.equal(f.timers.size, 1);
  }
  f.tick(100);
  assert.equal(f.controller.signal.reason.timeoutReason, "model_silence");
  assert.equal(f.controller.signal.reason.evidence.retryCount, 9);
});

test("model observe retains hard run deadline despite progress and warnings", () => {
  const f = fixture({
    modelIdlePolicy: "observe",
    modelIdleWarningMs: 100,
    modelIdleTimeoutMs: 200,
    runTimeoutMs: 1000
  });
  f.watchdog.activity(started);
  f.tick(900);
  assert.equal(f.controller.signal.aborted, false);
  assert.equal(f.records.filter((x) => x.event === "model_silence").length, 1);
  f.watchdog.activity(progress);
  f.tick(100);
  assert.equal(f.controller.signal.reason.timeoutStage, "run_deadline");
  assert.equal(f.controller.signal.reason.timeoutMs, 1000);
});

test("tool idle is isolated per tool and output cannot extend wall deadline", () => {
  const f = fixture({ toolTimeoutMs: 500, toolWallTimeoutMs: 1000 });
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "a" }
  });
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "b" }
  });
  f.tick(400);
  f.watchdog.activity({ kind: "turn_progress", method: "tool_delta", toolCallId: "a" });
  f.tick(100);
  assert.equal(f.controller.signal.reason.timeoutReason, "tool_idle");
  const g = fixture({ toolTimeoutMs: 500, toolWallTimeoutMs: 1000 });
  g.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "a" }
  });
  for (let i = 0; i < 4; i++) {
    g.tick(200);
    g.watchdog.activity({ kind: "turn_progress", method: "tool_delta", toolCallId: "a" });
  }
  g.tick(200);
  assert.equal(g.controller.signal.reason.timeoutReason, "tool_deadline");
});

test("last tool closing starts a fresh model budget and terminal cancels timers", () => {
  const f = fixture({ modelIdleTimeoutMs: 100, toolTimeoutMs: 1000 });
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "a" }
  });
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { status: "running", id: "b" }
  });
  f.tick(500);
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.update",
    payload: { id: "a", status: "completed" }
  });
  assert.equal(f.watchdog.snapshot().phase, "tool_active");
  f.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.update",
    payload: { id: "b", status: "completed" }
  });
  f.tick(99);
  assert.equal(f.controller.signal.aborted, false);
  f.watchdog.canonical({ protocolVersion: 2, type: "run.completed", payload: {} });
  f.tick(10_000);
  f.watchdog.activity(progress);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.signal.aborted, false);
});

test("native-aware canonical usage does not count as progress; legacy observe remains explicit opt-out", () => {
  const f = fixture({ modelIdleTimeoutMs: 100 });
  f.watchdog.activity(started);
  f.tick(90);
  f.watchdog.canonical({ protocolVersion: 2, type: "usage.update", payload: {} });
  f.tick(10);
  assert.equal(f.controller.signal.aborted, true);
  const g = fixture({ enforcement: "observe" });
  g.tick(2_000_000);
  assert.equal(g.controller.signal.aborted, false);
  g.watchdog.dispose();
});

test("invalid budgets and ambiguous legacy/v2 policies fail closed", () => {
  for (const limits of [
    { modelIdleTimeoutMs: NaN },
    { runTimeoutMs: 0 },
    { modelIdleTimeoutMs: 1.5 },
    { unknown: 1 },
    { modelIdlePolicy: "invalid" },
    { enforcement: "observe", modelIdlePolicy: "observe" }
  ]) {
    assert.throws(() => assertRuntimeLimits(limits));
  }
  assert.doesNotThrow(() => assertRuntimeLimits({ modelIdlePolicy: "observe", runTimeoutMs: 100 }));
});

test("approval waiting suspends idle budgets but retains the overall deadline", () => {
  const waiting = fixture({
    modelIdleTimeoutMs: 100,
    toolTimeoutMs: 100,
    toolWallTimeoutMs: 200,
    runTimeoutMs: 1000
  });
  waiting.watchdog.canonical({
    protocolVersion: 2,
    type: "tool_call.create",
    payload: { id: "tool", status: "running" }
  });
  waiting.watchdog.canonical({
    protocolVersion: 2,
    type: "interaction.requested",
    payload: { interactionId: "approval-a", kind: "approval" }
  });
  waiting.watchdog.canonical({
    protocolVersion: 2,
    type: "interaction.requested",
    payload: { interactionId: "approval-b", kind: "approval" }
  });
  waiting.tick(500);
  assert.equal(waiting.controller.signal.aborted, false);
  assert.equal(waiting.watchdog.snapshot().phase, "waiting_approval");
  waiting.watchdog.canonical({
    protocolVersion: 2,
    type: "interaction.resolved",
    payload: { interactionId: "approval-a", status: "resolved" }
  });
  waiting.tick(50);
  assert.equal(waiting.watchdog.snapshot().pendingInteractionCount, 1);
  waiting.watchdog.canonical({
    protocolVersion: 2,
    type: "interaction.resolved",
    payload: { interactionId: "approval-b", status: "resolved" }
  });
  waiting.tick(99);
  assert.equal(waiting.controller.signal.aborted, false);
  waiting.tick(1);
  assert.equal(waiting.controller.signal.reason.timeoutReason, "tool_idle");
  const deadline = fixture({ runTimeoutMs: 1000 });
  deadline.watchdog.canonical({
    protocolVersion: 2,
    type: "interaction.requested",
    payload: { interactionId: "approval", kind: "approval" }
  });
  deadline.tick(1000);
  assert.equal(deadline.controller.signal.reason.timeoutReason, "run_deadline");
});

const request = {
  protocolVersion: 2,
  invocationId: "watchdog-v2",
  agentSessionId: "s",
  runId: "r",
  prompt: "p",
  modelInput: "p",
  controlInstructions: "",
  approvalMode: "full_access",
  context: { schema: "octo.context-envelope/v3", items: [] },
  agentSource: "provisioned",
  agentConfig: {},
  workdir: process.cwd()
};
test("host preserves a single pending next during activity and ignores failing diagnostic sinks", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const host = new AdapterHost();
  host.register({
    metadata: {
      protocolSupport: {
        protocol: "native" + ".canonical",
        modes: ["canonical"],
        nativeMethods: []
      },
      type: "native",
      agentSources: ["provisioned"]
    },
    invoke(req, ctx) {
      ctx.reportActivity(started);
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          calls++;
          active++;
          peak = Math.max(peak, active);
          try {
            if (calls > 1) return { done: true };
            for (let i = 0; i < 4; i++) {
              await new Promise((r) => setTimeout(r, 40));
              ctx.reportActivity(progress);
            }
            return {
              done: false,
              value: { protocolVersion: 2, type: "run.completed", payload: {} }
            };
          } finally {
            active--;
          }
        }
      };
    }
  });
  const events = [];
  for await (const e of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "native",
    {
      ...request,
      runtimeLimits: { modelIdleTimeoutMs: 100, modelIdleWarningMs: 100, runTimeoutMs: 1000 }
    },
    { protocolMode: "canonical" }
  ))
    events.push(e);
  assert.equal(peak, 1);
  assert.equal(calls, 2);
  assert.equal(events.at(-1).type, "run.completed");
});

test("host uses canonical progress until this invocation actually reports native work", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: {
      protocolSupport: { protocol: "fallback.canonical", modes: ["canonical"], nativeMethods: [] },
      type: "fallback",
      agentSources: ["provisioned"]
    },
    async *invoke() {
      for (let index = 0; index < 4; index++) {
        yield event("message.delta", { text: "working" });
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      yield event("run.completed");
    }
  });
  const events = [];
  for await (const value of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "fallback",
    {
      ...request,
      invocationId: "canonical-fallback",
      runtimeLimits: { modelIdleTimeoutMs: 100, runTimeoutMs: 1000 }
    },
    { protocolMode: "canonical" }
  ))
    events.push(value);
  assert.equal(events.at(-1).type, "run.completed");
});

test("host hard deadline aborts provider even when its consumer is paused", async () => {
  let signal;
  const host = new AdapterHost();
  host.register({
    metadata: {
      protocolSupport: {
        protocol: "paused" + ".canonical",
        modes: ["canonical"],
        nativeMethods: []
      },
      type: "paused",
      agentSources: ["provisioned"]
    },
    async *invoke(req) {
      signal = req.signal;
      yield { protocolVersion: 2, type: "message.create", payload: {} };
      await new Promise(() => {});
    }
  });
  const iterator = preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "paused",
    {
      ...request,
      runtimeLimits: { runTimeoutMs: 100, cancelGraceMs: 100, modelIdlePolicy: "observe" }
    },
    { protocolMode: "canonical" }
  );
  await iterator.next();
  await new Promise((r) => setTimeout(r, 130));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.timeoutReason, "run_deadline");
  const events = [];
  for await (const e of iterator) events.push(e);
  assert.equal(events.at(-1).payload.failure.params.timeoutReason, "run_deadline");
});

test("host bounds cleanup after terminal and timeout wins over provider stopped projection", async () => {
  const host = new AdapterHost();
  host.register({
    metadata: {
      protocolSupport: {
        protocol: "cleanup" + ".canonical",
        modes: ["canonical"],
        nativeMethods: []
      },
      type: "cleanup",
      agentSources: ["provisioned"]
    },
    async *invoke() {
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
      await new Promise(() => {});
    }
  });
  const events = [];
  for await (const e of preparedTestInvoke((...args) => preparedFrames(host, ...args))(
    "cleanup",
    { ...request, runtimeLimits: { cancelGraceMs: 100 } },
    { protocolMode: "canonical" }
  ))
    if (!e.type.startsWith("activity.")) events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.failure.params.timeoutReason, "cleanup_timeout");
});
