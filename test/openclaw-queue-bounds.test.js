import test from "node:test";
import assert from "node:assert/strict";
import { DriverQueue } from "../packages/octo-runtime-adapter-sdk/dist/index.js";
import { createOpenClawAdapter } from "../packages/octo-runtime-adapter-openclaw/dist/index.js";

function fixture() {
  let listener,
    finish,
    runId,
    closed = 0,
    unsubscribed = 0,
    factories = 0;
  const calls = [];
  const client = {
    connect: async () => ({
      protocol: 4,
      features: {
        methods: [
          "agents.list",
          "sessions.create",
          "sessions.messages.subscribe",
          "agent",
          "agent.wait",
          "sessions.abort"
        ],
        events: ["agent"]
      }
    }),
    onEvent(fn) {
      listener = fn;
      return () => {
        unsubscribed++;
        listener = () => {};
      };
    },
    async close() {
      closed++;
      finish?.({ status: "ok" });
    },
    async request(method, params, options = {}) {
      calls.push(method);
      if (method === "agents.list") return { agents: [{ id: "main" }] };
      if (method === "sessions.create") return { key: params.key };
      if (method === "agent.wait") return { status: "ok" };
      if (method !== "agent") return {};
      runId = "accepted-real-run";
      options.onAccepted({ runId });
      listener({
        event: "agent",
        payload: { runId, seq: 1, stream: "lifecycle", data: { phase: "start" } }
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  };
  const adapter = createOpenClawAdapter({
    clientFactory: () => {
      factories++;
      return client;
    }
  });
  const source = adapter.invoke({
    protocolVersion: 2,
    invocationId: "queue-test",
    agentSessionId: "s",
    runId: "r",
    prompt: "p",
    modelInput: "p",
    context: { schema: "octo.context-envelope/v3", items: [] },
    controlInstructions: "",
    approvalMode: "full_access",
    agentSource: "preset",
    workdir: "",
    agentConfig: {
      providerAgentId: "main",
      providerOptions: {
        OPENCLAW_GATEWAY_URL: "ws://localhost:1",
        OPENCLAW_GATEWAY_TOKEN: "fixture",
        OPENCLAW_GATEWAY_DEVICE_ID: "d",
        OPENCLAW_GATEWAY_PUBLIC_KEY: "p",
        OPENCLAW_GATEWAY_PRIVATE_KEY: "k"
      }
    }
  });
  return {
    source,
    calls,
    emit: (value) => listener(value),
    own: (seq, text = "x") =>
      listener({ event: "agent", payload: { runId, seq, stream: "assistant", data: { text } } }),
    finish: () => finish({ status: "ok" }),
    stats: () => ({ closed, unsubscribed, factories })
  };
}

test("100000 unrelated broadcasts are filtered before queue.push while consumption is paused", async (t) => {
  const f = fixture();
  const original = DriverQueue.prototype.push;
  let pushes = 0;
  t.mock.method(DriverQueue.prototype, "push", function (value) {
    pushes++;
    return original.call(this, value);
  });
  await f.source.next();
  await f.source.next();
  const before = pushes;
  for (let i = 0; i < 100000; i++)
    f.emit({
      event: "agent",
      payload: {
        runId: "foreign",
        data: { text: "x".repeat(4096) + i }
      }
    });
  f.emit({
    event: "exec.approval.requested",
    payload: { id: "foreign", request: { sessionKey: "foreign" } }
  });
  f.emit({ event: "exec.approval.resolved", payload: { id: "foreign" } });
  assert.equal(pushes, before);
  f.own(2, "first accepted output");
  f.finish();
  const events = [];
  for await (const event of f.source) events.push(event);
  assert.equal(events.at(-1).type, "run.completed");
  assert.ok(events.some((e) => e.payload.text === "first accepted output"));
  assert.deepEqual(f.stats(), { closed: 1, unsubscribed: 1, factories: 1 });
});

test("overflow cleans up a paused invocation immediately without reconnecting or reporting success", async () => {
  const f = fixture();
  await f.source.next();
  await f.source.next();
  for (let i = 0; i < 4097; i++) f.own(i + 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.stats(), { closed: 1, unsubscribed: 1, factories: 1 });
  assert.equal(f.calls.filter((m) => m === "sessions.abort").length, 1);
  const events = [];
  for await (const event of f.source) events.push(event);
  assert.equal(events.at(-1).type, "run.failed");
  assert.match(events.at(-1).payload.message, /STREAM_QUEUE_ITEMS_EXCEEDED/);
  assert.equal(
    events.some((e) => e.type === "run.completed"),
    false
  );
});

test("DriverQueue exact item, count and byte boundaries discard backlog on failure", async () => {
  for (const [count, size, expected] of [
    [16, 1, "STREAM_QUEUE_ITEMS_EXCEEDED"],
    [4, 64 * 1024, "STREAM_QUEUE_BYTES_EXCEEDED"]
  ]) {
    let failure;
    const queue = new DriverQueue({
      discardOnFailure: true,
      limits: {
        adapterQueueItemMaxBytes: 128 * 1024,
        adapterQueueMaxBytes: 256 * 1024,
        adapterQueueMaxItems: 16
      },
      onFailure: (e) => {
        failure = e;
      }
    });
    const value = size === 1 ? 0 : "x".repeat(size - 2);
    for (let i = 0; i < count; i++) queue.push(value);
    assert.equal(failure, undefined);
    queue.push(value);
    assert.match(failure.message, new RegExp(expected));
    assert.deepEqual(queue.drain(), []);
    await assert.rejects(queue[Symbol.asyncIterator]().next(), new RegExp(expected));
  }
  const queue = new DriverQueue({
    discardOnFailure: true,
    limits: {
      adapterQueueItemMaxBytes: 256 * 1024,
      adapterQueueMaxBytes: 512 * 1024,
      adapterQueueMaxItems: 16
    }
  });
  queue.push("x".repeat(256 * 1024 - 1));
  await assert.rejects(queue[Symbol.asyncIterator]().next(), /STREAM_QUEUE_ITEM_TOO_LARGE/);
});

test("early consumer return cancels the accepted provider run and detaches once", async () => {
  const f = fixture();
  await f.source.next();
  await f.source.next();
  await f.source.return();
  assert.deepEqual(f.stats(), { closed: 1, unsubscribed: 1, factories: 1 });
  assert.ok(f.calls.includes("sessions.abort"));
});

test(
  "filtered broadcast batches do not retain their payloads after GC",
  { skip: !global.gc },
  async () => {
    const f = fixture();
    await f.source.next();
    await f.source.next();
    global.gc();
    const baseline = process.memoryUsage().heapUsed;
    try {
      for (let round = 0; round < 3; round++) {
        for (let i = 0; i < 10000; i++)
          f.emit({
            event: "agent",
            payload: {
              runId: "foreign",
              data: { text: Buffer.from("x".repeat(4096) + i).toString() }
            }
          });
        global.gc();
        assert.ok(process.memoryUsage().heapUsed - baseline < 8 * 1024 * 1024);
      }
    } finally {
      await f.source.return();
    }
  }
);
