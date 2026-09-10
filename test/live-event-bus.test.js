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
  bus.publish({ source: "daemon", type: "one", runId: "run-a", payload: {} });
  bus.publish({ source: "adapter-rpc", type: "two", runId: "run-b", payload: {} });
  const snapshot = [];
  for await (const event of bus.subscribe({ runId: "run-b" })) snapshot.push(event);
  assert.deepEqual(snapshot.map(event => event.type), ["two"]);

  const stream = bus.subscribe({ source: "host-canonical" }, true);
  const pending = stream.next();
  bus.publish({ source: "daemon", type: "ignored", payload: {} });
  bus.publish({ source: "host-canonical", type: "run.finished", payload: {} });
  assert.equal((await pending).value.type, "run.finished");
  await stream.return();
});

test("LiveEventBus emits the v1 envelope and strips private reasoning", async () => {
  const bus = new LiveEventBus();
  bus.publish({
    source: "provider-native",
    type: "provider.output",
    runId: "run-safe",
    payload: { exposure: "private_reasoning", reasoning: "secret chain", summary: "public answer" }
  });
  const values = [];
  for await (const event of bus.subscribe()) values.push(event);
  assert.equal(values[0].schema, "octo-harness.live-event/v1");
  assert.equal(values[0].agent_run_id, "run-safe");
  assert.doesNotMatch(JSON.stringify(values[0]), /secret chain/);
  assert.match(JSON.stringify(values[0]), /public answer/);
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
