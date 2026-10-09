import test from "node:test";
import assert from "node:assert/strict";
import { LiveEventBus } from "@mininglamp-oss/octo-harness-daemon-app";

test("LiveEventBus enforces byte, frame, slot, and subscriber bounds", async () => {
  const bus = new LiveEventBus({ maxBytes: 1024, maxFrameBytes: 512, maxSlots: 4, maxSubscribers: 1 });
  for (let index = 0; index < 20; index++) {
    bus.publish({ source: "daemon", type: "sample", runId: `run-${index % 2}`, payload: { body: "x".repeat(180) } });
    assert.ok(bus.stats.retainedBytes <= 1024);
    assert.ok(bus.stats.retainedEvents <= 4);
  }
  bus.publish({ source: "daemon", type: "redacted", payload: { authorization: "Bearer secret", visible: true } });
  bus.publish({ source: "adapter-rpc", type: "huge", payload: { body: "x".repeat(2048) } });
  const snapshot = [];
  for await (const event of bus.subscribe()) snapshot.push(event);
  const redacted = snapshot.find(event => event.type === "redacted");
  assert.deepEqual(redacted.payload, { visible: true });
  assert.ok(snapshot.some(event => event.type === "event.oversize_dropped"));
  assert.ok(bus.stats.droppedEvents >= 1);
  assert.ok(bus.stats.controlBytes <= 512);

  const first = bus.subscribe({}, true);
  const pending = first.next();
  await assert.rejects(async () => {
    const second = bus.subscribe({}, true);
    await second.next();
  }, error => error.code === "BUS_SUBSCRIBER_LIMIT");
  await pending;
  await first.return();
  assert.equal(bus.stats.subscribers, 0);
});

test("LiveEventBus keeps a pinned frame bounded and releases retired storage", async () => {
  const bus = new LiveEventBus({ maxBytes: 900, maxFrameBytes: 500, maxSlots: 3 });
  bus.publish({ source: "daemon", type: "first", payload: { body: "x".repeat(220) } });
  const stream = bus.subscribe({}, true);
  assert.equal((await stream.next()).value.type, "first");
  for (let index = 0; index < 10; index++) {
    bus.publish({ source: "daemon", type: `next-${index}`, payload: { body: "y".repeat(220) } });
    assert.ok(bus.stats.retainedBytes <= 900);
  }
  assert.equal(bus.stats.retiredEvents, 1);
  assert.equal((await stream.next()).value.type, "bus.gap");
  await stream.return();
  assert.equal(bus.stats.retiredEvents, 0);
  assert.equal(bus.stats.subscribers, 0);
  assert.ok(bus.stats.retainedBytes <= 900);
});

test("LiveEventBus filters snapshots without waiting and follows new matching events", async () => {
  const bus = new LiveEventBus();
  bus.publish({ source: "daemon", type: "one", profile: "default", runId: "run-a", payload: {} });
  bus.publish({ source: "adapter-rpc", type: "two", profile: "work", runId: "run-b", payload: {} });
  const snapshot = [];
  for await (const event of bus.subscribe({ runId: "run-b" })) snapshot.push(event);
  assert.deepEqual(snapshot.map(event => event.type), ["two"]);
  const workSnapshot = [];
  for await (const event of bus.subscribe({ profile: "work" })) workSnapshot.push(event);
  assert.deepEqual(workSnapshot.map(event => [event.profile, event.type]), [["work", "two"]]);

  const stream = bus.subscribe({ source: "host-canonical" }, true);
  const pending = stream.next();
  bus.publish({ source: "daemon", type: "ignored", payload: {} });
  bus.publish({ protocolVersion: 2, source: "host-canonical", type: "run.completed", payload: {} });
  assert.equal((await pending).value.type, "run.completed");
  await stream.return();
});

test("LiveEventBus can follow from the current tail without replaying its snapshot", async () => {
  const bus = new LiveEventBus();
  bus.publish({ source: "daemon", type: "before-pause", payload: {} });
  const controller = new AbortController();
  const stream = bus.subscribeBytes({}, true, controller.signal, false);
  const pending = stream.next();
  bus.publish({ source: "daemon", type: "after-resume", payload: {} });
  const result = await pending;
  assert.equal(JSON.parse(result.value.toString("utf8")).type, "after-resume");
  controller.abort();
  await stream.return();
  assert.equal(bus.stats.subscribers, 0);
});

test("LiveEventBus emits the v1 envelope and strips private reasoning", async () => {
  const bus = new LiveEventBus();
  bus.publish({
    source: "provider-native",
    type: "provider.output",
    profile: "work",
    runtimeId: "runtime-work",
    runId: "run-safe",
    agentSessionId: "session-safe",
    invocationId: "invoke-safe",
    adapterType: "codebuddy",
    durationMs: 312.5,
    payload: { exposure: "private_reasoning", reasoning: "secret chain", summary: "public answer" }
  });
  const values = [];
  for await (const event of bus.subscribe()) values.push(event);
  assert.equal(values[0].schema, "octo-harness.live-event/v1");
  assert.equal(values[0].stage, "adapter.native");
  assert.equal(values[0].direction, "outbound");
  assert.equal(values[0].profile, "work");
  assert.equal(values[0].runtime_id, "runtime-work");
  assert.equal(values[0].agent_run_id, "run-safe");
  assert.equal(values[0].agent_session_id, "session-safe");
  assert.equal(values[0].invocation_id, "invoke-safe");
  assert.equal(values[0].adapter_type, "codebuddy");
  assert.equal(values[0].duration_ms, 312.5);
  assert.doesNotMatch(JSON.stringify(values[0]), /secret chain/);
  assert.match(JSON.stringify(values[0]), /public answer/);
});

test("LiveEventBus maps observability records to canonical stages, directions, and identity headers", async () => {
  const bus = new LiveEventBus();
  const base = {
    schema_version: 1,
    ts: "2026-09-15T00:00:00.000Z",
    level: "trace",
    component: "daemon",
    scope: "adapter-host.rpc",
    event: "rpc.frame",
    message: "adapter-host RPC",
    pid: 42,
    process_instance_id: "proc-test",
    seq: 1,
    sensitivity: "restricted",
    profile: "work",
    runtime_id: "runtime-work",
    run_id: "run-rpc",
    agent_session_id: "session-rpc",
    invocation_id: "invoke-rpc",
    agent_source: "provisioned", adapter_type: "codebuddy",
    duration_ms: 17.25
  };
  bus.publishRecord({ ...base, data: { direction: "send", frame: { method: "invoke" } } });
  bus.publishRecord({ ...base, seq: 2, data: { direction: "receive", frame: { method: "invoke.event" } } });
  const values = [];
  for await (const event of bus.subscribe()) values.push(event);
  assert.deepEqual(values.map(event => [event.stage, event.direction]), [
    ["wire.daemon_host", "inbound"],
    ["wire.daemon_host", "outbound"]
  ]);
  assert.deepEqual(
    values.map(event => [event.profile, event.runtime_id, event.agent_run_id, event.agent_session_id, event.invocation_id, event.adapter_type]),
    Array.from({ length: 2 }, () => ["work", "runtime-work", "run-rpc", "session-rpc", "invoke-rpc", "codebuddy"])
  );
  assert.deepEqual(values.map(event => event.duration_ms), [17.25, 17.25]);
});

test("LiveEventBus aborts an idle follower without leaking a subscriber", async () => {
  const bus = new LiveEventBus();
  const controller = new AbortController();
  const stream = bus.subscribe({}, true, controller.signal);
  const pending = stream.next();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bus.stats.subscribers, 1);
  controller.abort();
  assert.equal((await pending).done, true);
  assert.equal(bus.stats.subscribers, 0);
});

test("LiveEventBus soak returns subscriber and retired state to baseline", async () => {
  const bus = new LiveEventBus({ maxBytes: 64 * 1024, maxFrameBytes: 2048, maxSlots: 128 });
  for (let index = 0; index < 50_000; index++) {
    bus.publish({ source: "daemon", type: "soak", runId: `run-${index % 100}`, payload: { index, body: "z".repeat(256) } });
  }
  for (let index = 0; index < 500; index++) {
    const controller = new AbortController();
    const stream = bus.subscribe({ runId: "never" }, true, controller.signal);
    const pending = stream.next();
    controller.abort();
    await pending;
  }
  assert.equal(bus.stats.subscribers, 0);
  assert.equal(bus.stats.retiredEvents, 0);
  assert.ok(bus.stats.retainedBytes <= 64 * 1024);
  assert.ok(bus.stats.retainedEvents <= 128);
});
