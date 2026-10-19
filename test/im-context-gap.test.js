import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import {
  ImRuntime,
  build_im_contexts
} from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { MemoryImSessionStore } from "../packages/octo-runtime-extra-channel-gateway/dist/application/session-store.js";

const config = {
  bot_id: "gap-bot",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "gap-space",
  adapter: { adapter_type: "codex", workdir: process.cwd() }
};

async function fixture(context, behavior, historyResponse) {
  let callbacks;
  let storeKey;
  let prepares = 0;
  const requests = [];
  const historyCalls = [];
  const controls = [];
  const tokens = new Map();
  const store = new MemoryImSessionStore();
  const save = store.save.bind(store);
  context.mock.method(store, "save", (key, value) => {
    storeKey = key;
    save(key, value);
  });
  context.mock.method(GatewayTransport.prototype, "start", async function () {
    callbacks = this.callbacks;
  });
  context.mock.method(GatewayTransport.prototype, "close", async () => {});
  context.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    const input = JSON.parse(options.body);
    historyCalls.push(input);
    return historyResponse
      ? historyResponse(input, options.signal)
      : Response.json({ more: 0, messages: [] });
  });
  const runtime = new ImRuntime(config, {
    sessions: store,
    prepareContexts: async () => {
      prepares++;
      return [];
    },
    host: {
      async *invoke(request) {
        requests.push(request);
        if (behavior) yield* behavior(request, requests.length);
        else {
          yield {
            protocolVersion: 2,
            type: "session.update",
            payload: { providerSession: { sessionId: "provider" } }
          };
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        }
      },
      async cancel() {
        return { cancelled: true };
      }
    }
  });
  context.after(() => runtime.close());
  await runtime.start();
  const send = (sequence, overrides = {}) => {
    const incoming = {
      messageId: String(sequence),
      senderId: "owner",
      conversationId: "group____topic",
      conversationKind: "thread",
      text: "summary",
      position: { messageSeq: sequence },
      async reply() {},
      bindHistoryTurn: (token) => tokens.set(sequence, token),
      beginPresentation: (_run, _diagnostic, control) => {
        controls.push(control);
        return { update() {}, async finish() {} };
      },
      async buildContext(signal, options) {
        return {
          schema: "octo.context-envelope/v3",
          items: await build_im_contexts(
            config,
            {
              channelId: "group____topic",
              channelType: 5,
              messageId: String(sequence),
              messageSeq: sequence,
              fromUid: "owner",
              payload: { type: 1, content: "summary" }
            },
            "bf_fixture",
            signal,
            options
          )
        };
      },
      ...overrides
    };
    callbacks.onMessage(incoming);
    return incoming;
  };
  const idle = async () => {
    for (let attempt = 0; runtime.status.workingTasks && attempt < 1000; attempt++) await settle();
    assert.equal(runtime.status.workingTasks, 0);
  };
  const observe = (messageSeq, extra = {}) =>
    callbacks.onPosition({
      conversationId: "group____topic",
      conversationKind: "thread",
      messageSeq,
      ...extra
    });
  return {
    runtime,
    send,
    idle,
    observe,
    requests,
    historyCalls,
    tokens,
    controls,
    binding: () => store.read(storeKey),
    setPendingAfterSeq: (pendingAfterSeq) => {
      const binding = store.read(storeKey);
      assert.equal(
        store.patchGap(
          storeKey,
          { sessionId: binding.id, generation: binding.generation },
          (previous) => ({ ...previous, pendingAfterSeq })
        ),
        true
      );
    },
    prepares: () => prepares
  };
}

test("HG-02/14 own ACKs are generation-bound and duplicate or out-of-order observations use max only", async (context) => {
  const current = await fixture(context);
  current.send(100);
  await current.idle();
  current.observe(101, { own: true, turn: current.tokens.get(100) });
  current.send(102);
  await current.idle();
  assert.equal(
    current.requests[1].contexts.items.some((item) => item.name === "history-gap"),
    false
  );
  assert.equal(current.requests[1].providerSession.sessionId, "provider");
  for (const sequence of [106, 104, 106]) current.observe(sequence);
  assert.equal(current.binding().gap.latestObservedSeq, 106);
  assert.equal(current.binding().gap.observationVisibility, "partial");
});

test("HG-15/16 queued mentions freeze U and read L only when their turn starts", async (context) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = await fixture(context, async function* (_request, count) {
    if (count === 2) await gate;
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  current.send(100);
  await current.idle();
  current.send(103);
  while (current.requests.length < 2) await settle();
  const queued = current.send(106);
  queued.position.messageSeq = 999;
  current.observe(500);
  assert.equal(current.binding().gap.preparedTriggerSeq, 103);
  release();
  await current.idle();
  const gaps = current.requests
    .slice(1)
    .map((request) => request.contexts.items.find((item) => item.name === "history-gap"));
  assert.deepEqual(
    gaps.map((item) => item.payload.range),
    [
      { beforeSeq: 103, afterSeq: 100 },
      { beforeSeq: 106, afterSeq: 103 }
    ]
  );
  assert.equal(current.binding().gap.latestObservedSeq, 500);
  assert.equal(current.binding().gap.preparedTriggerSeq, 106);
});

test("HG-17 failed preparation or cancellation does not advance preparation boundaries", async (context) => {
  const current = await fixture(context);
  current.send(100);
  await current.idle();
  current.send(103, {
    async buildContext() {
      throw Error("fixture failure");
    }
  });
  await current.idle();
  assert.equal(current.binding().gap.preparedTriggerSeq, 100);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  current.send(104, {
    async buildContext(signal) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      signal.throwIfAborted();
    }
  });
  await ready;
  current.send(105, { text: "/stop" });
  await current.idle();
  assert.equal(current.binding().gap.preparedTriggerSeq, 100);
  assert.equal(current.binding().gap.pendingAfterSeq, undefined);
  assert.equal(current.requests.length, 1);
  current.send(107);
  await current.idle();
  assert.equal(
    current.requests.at(-1).contexts.items.find((item) => item.name === "history-gap").payload.range
      .afterSeq,
    100
  );
});

test("HG-18 failure leaves a repairable interval that includes the failed trigger", async (context) => {
  const current = await fixture(context, async function* (_request, count) {
    yield { protocolVersion: 2, type: count === 2 ? "run.failed" : "run.completed", payload: {} };
  });
  for (const sequence of [100, 103, 104]) {
    current.send(sequence);
    await current.idle();
  }
  const gap = current.requests[2].contexts.items.find((item) => item.name === "history-gap");
  assert.equal(gap.payload.range.afterSeq, 100);
  assert.equal(gap.payload.range.beforeSeq, 104);
  assert.equal(current.binding().gap.pendingAfterSeq, undefined);
});

test("HG-19 same-generation card retry reuses frozen contexts without new history or configured-context IO", async (context) => {
  const current = await fixture(context, async function* (_request, count) {
    yield { protocolVersion: 2, type: count === 2 ? "run.failed" : "run.completed", payload: {} };
  });
  current.send(100);
  await current.idle();
  current.send(103);
  await current.idle();
  const gap = current.requests[1].contexts.items.find((item) => item.name === "history-gap");
  const revision = current.binding().gap.revision;
  const fetches = current.historyCalls.length;
  assert.equal(current.controls[1].retry("owner", "retry-1"), true);
  await current.idle();
  assert.deepEqual(
    current.requests[2].contexts.items.find((item) => item.name === "history-gap"),
    gap
  );
  assert.equal(current.prepares(), 2);
  assert.equal(current.binding().gap.revision, revision);
  assert.equal(current.historyCalls.length, fetches);
});

test("HG-20 reset rejects old-generation ACKs and late handoff patches", async (context) => {
  let finish;
  const gate = new Promise((resolve) => {
    finish = resolve;
  });
  const current = await fixture(context, async function* (_request, count) {
    if (count === 2) await gate;
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  current.send(100);
  await current.idle();
  const oldToken = current.tokens.get(100);
  current.send(103);
  while (current.requests.length < 2) await settle();
  current.send(104, { text: "/reset" });
  current.send(106);
  current.observe(105, { own: true, turn: oldToken });
  finish();
  await current.idle();
  assert.equal(current.binding().generation, 2);
  assert.deepEqual(current.binding().gap.localOutputSeqs, []);
  assert.equal(current.binding().gap.preparedTriggerSeq, 106);
  assert.equal(current.requests[2].providerSession, undefined);
});

test("HG-22 ten thousand unmentioned scopes never allocate sessions; own positions remain bounded", async (context) => {
  const current = await fixture(context);
  for (let index = 0; index < 10_000; index++)
    current.observe(1, { conversationId: `unmentioned-${index}` });
  assert.equal(current.runtime.status.sessions.length, 0);
  assert.equal(current.requests.length, 0);
  current.send(100);
  await current.idle();
  for (let sequence = 101; sequence < 200; sequence++)
    current.observe(sequence, { own: true, turn: current.tokens.get(100) });
  assert.equal(current.binding().gap.localOutputSeqs.length, 32);
});

test("HG-27 fresh fallback reloads one bounded window on the next turn without another invoke", async (context) => {
  const current = await fixture(context, async function* (_request, count) {
    yield {
      protocolVersion: 2,
      type: "session.update",
      payload: {
        providerSession: {
          sessionId: "provider",
          ...(count === 2 ? { resumeOutcome: "fresh_fallback" } : {})
        }
      }
    };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  });
  for (const sequence of [100, 103, 104]) {
    current.send(sequence);
    await current.idle();
  }
  assert.equal(current.requests.length, 3);
  assert.equal(
    current.requests[2].contexts.items.find((item) => item.name === "history-gap").payload.mode,
    "bootstrap"
  );
  current.send(105);
  await current.idle();
  assert.equal(
    current.requests[3].contexts.items.find((item) => item.name === "history-gap"),
    undefined
  );
  assert.equal(current.historyCalls.length, 3);
  assert.equal(current.historyCalls[2].limit, 15);
  assert.equal(current.historyCalls[2].start_message_seq, 103);
  assert.equal(current.historyCalls[2].end_message_seq, 0);
});

test("a resumed topic receives two discussion messages through API before model execution", async (context) => {
  let callbacks;
  const requests = [];
  context.mock.method(GatewayTransport.prototype, "start", async function () {
    callbacks = this.callbacks;
  });
  context.mock.method(GatewayTransport.prototype, "close", async () => {});
  context.mock.method(globalThis, "fetch", async (url, options) =>
    String(url).endsWith("/md")
      ? Response.json({}, { status: 404 })
      : Response.json({
          messages:
            JSON.parse(options.body).start_message_seq === 102
              ? [101, 102].map((sequence) => ({
                  message_id: String(sequence),
                  message_seq: sequence,
                  from_uid: "peer",
                  payload: { type: 1, content: `decision-${sequence}` }
                }))
              : [],
          more: 0
        })
  );
  const runtime = new ImRuntime(config, {
    host: {
      async *invoke(request) {
        requests.push(request);
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      },
      async cancel() {
        return { cancelled: true };
      }
    }
  });
  context.after(() => runtime.close());
  await runtime.start();
  const inbound = (sequence) => ({
    messageId: String(sequence),
    senderId: "owner",
    conversationId: "group____topic",
    conversationKind: "thread",
    text: "summarize the discussion above",
    position: { messageSeq: sequence },
    async reply() {},
    async buildContext(signal, options) {
      return {
        schema: "octo.context-envelope/v3",
        items: await build_im_contexts(
          config,
          {
            channelId: "group____topic",
            channelType: 5,
            messageId: String(sequence),
            messageSeq: sequence,
            fromUid: "owner",
            payload: { type: 1, content: "summary" }
          },
          "bf_fixture",
          signal,
          options
        )
      };
    }
  });
  callbacks.onMessage(inbound(100));
  while (runtime.status.workingTasks) await settle();
  for (const messageSeq of [101, 102])
    callbacks.onPosition?.({
      conversationId: "group____topic",
      conversationKind: "thread",
      messageSeq
    });
  assert.equal(requests.length, 1);
  callbacks.onMessage(inbound(103));
  while (runtime.status.workingTasks) await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  const gap = requests[1].contexts.items.find((item) => item.name === "history-gap");
  assert.ok(gap, "resumed sessions must not silently omit intervening discussion");
  assert.equal(gap.payload.messageLimit, 2);
  assert.deepEqual(gap.payload.range, { afterSeq: 100, beforeSeq: 103 });
  assert.equal(gap.payload.status, "provided");
  assert.equal(gap.payload.materialProvided, true);
  assert.equal(gap.payload.argv, undefined);
  assert.equal(
    requests[1].contexts.items.find((item) => item.name === "history").payload.text,
    "peer：decision-101\npeer：decision-102"
  );
});

test("history API completion precedes host.invoke", async (context) => {
  let release;
  let waiting;
  const started = new Promise((resolve) => {
    waiting = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const current = await fixture(context, undefined, async (input, signal) => {
    if (input.start_message_seq === 102) {
      waiting();
      await Promise.race([
        gate,
        new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      ]);
      signal.throwIfAborted();
      return Response.json({
        more: 0,
        messages: [
          {
            message_id: "102",
            message_seq: 102,
            from_uid: "peer",
            payload: { type: 1, content: "loaded before invoke" }
          }
        ]
      });
    }
    return Response.json({ more: 0, messages: [] });
  });
  current.send(100);
  await current.idle();
  current.send(103);
  await started;
  assert.equal(current.requests.length, 1);
  release();
  await current.idle();
  assert.equal(current.requests.length, 2);
  assert.equal(
    current.requests[1].contexts.items.find((item) => item.name === "history").payload.text,
    "peer：loaded before invoke"
  );
  assert.equal(current.historyCalls.length, 2);
});

test("stop during history API preparation aborts the request and never invokes the model", async (context) => {
  let waiting;
  let aborted = false;
  const started = new Promise((resolve) => {
    waiting = resolve;
  });
  const current = await fixture(context, undefined, async (input, signal) => {
    if (input.start_message_seq === 102) {
      waiting();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      aborted = signal.aborted;
      signal.throwIfAborted();
    }
    return Response.json({ more: 0, messages: [] });
  });
  current.send(100);
  await current.idle();
  current.send(103);
  await started;
  current.send(104, { text: "/stop" });
  await current.idle();
  assert.equal(aborted, true);
  assert.equal(current.requests.length, 1);
  assert.equal(current.binding().gap.preparedTriggerSeq, 100);
});

for (const pendingAfterSeq of [98, null])
  test(`review regression: failed run retains the effective pending lower bound ${pendingAfterSeq}`, async (context) => {
    const current = await fixture(
      context,
      async function* (_request, count) {
        yield {
          protocolVersion: 2,
          type: count === 2 ? "run.failed" : "run.completed",
          payload: {}
        };
      },
      async (input) => {
        const lower = Math.max(
          input.end_message_seq + 1,
          input.start_message_seq - input.limit + 1
        );
        return Response.json({
          more: 0,
          messages: Array.from({ length: input.start_message_seq - lower + 1 }, (_, index) => ({
            message_id: String(lower + index),
            message_seq: lower + index,
            from_uid: "peer",
            payload: { type: 1, content: `discussion-${lower + index}` }
          }))
        });
      }
    );
    current.send(101);
    await current.idle();
    current.setPendingAfterSeq(pendingAfterSeq);
    current.send(104);
    await current.idle();
    assert.ok(current.requests[1].contexts.items.find((item) => item.name === "history"));
    assert.equal(current.binding().gap.pendingAfterSeq, pendingAfterSeq);
    current.send(106);
    await current.idle();
    assert.equal(current.historyCalls[2].end_message_seq, pendingAfterSeq ?? 0);
    assert.equal(current.historyCalls[2].limit, pendingAfterSeq === null ? 15 : 7);
    assert.equal(current.binding().gap.pendingAfterSeq, undefined);
  });

test("review regression: failure without a new history query retains the known lower bound", async (context) => {
  const current = await fixture(context, async function* (_request, count) {
    yield { protocolVersion: 2, type: count === 2 ? "run.failed" : "run.completed", payload: {} };
  });
  current.send(101);
  await current.idle();
  current.send(102);
  await current.idle();
  assert.equal(current.historyCalls.length, 1);
  assert.equal(current.binding().gap.pendingAfterSeq, 101);
  current.send(104);
  await current.idle();
  assert.equal(current.historyCalls[1].end_message_seq, 101);
  assert.equal(current.historyCalls[1].limit, 2);
});
