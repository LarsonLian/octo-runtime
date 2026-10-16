import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";

test("F26: Bot working 64 and session waiting 4 are independent; rejection never invokes or marks read", async (t) => {
  let receive, release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = this.callbacks.onMessage;
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const calls = [],
    reads = [],
    texts = [],
    cards = [];
  const runtime = new ImRuntime(
    {
      bot_id: "fixture",
      api_url: "https://im-test.deepminer.com.cn/api",
      adapter: { adapter_type: "codex" }
    },
    {
      host: {
        async *invoke(input, environment) {
          calls.push(input);
          await Promise.race([
            gate,
            new Promise((resolve) =>
              environment.signal.addEventListener("abort", resolve, { once: true })
            )
          ]);
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() {
          release();
          return { cancelled: true };
        },
        async respondInteraction() {}
      }
    }
  );
  await runtime.start();
  t.after(() => runtime.close());
  let id = 0;
  const send = (session, overrides = {}) =>
    receive({
      messageId: `m${++id}`,
      senderId: "owner",
      conversationId: session,
      conversationKind: "group",
      text: "work",
      async markRead() {
        reads.push(id);
      },
      async buildContext() {
        return { schema: "octo.context-envelope/v3", items: [] };
      },
      async reply(text) {
        texts.push(text);
      },
      async replyFailure(event) {
        cards.push(event);
      },
      ...overrides
    });
  for (let session = 0; session < 20; session++)
    for (let task = 0; task < 5; task++) send(`s${session}`);
  await settle();
  assert.equal(calls.length, 20);
  assert.equal(runtime.status.workingTasks, 20);
  assert.equal(runtime.status.queuedTasks, 80);
  send("s0");
  await settle();
  assert.equal(cards.at(-1).payload.failure.code, "OH-RUN-2004");
  assert.match(texts.at(-1), /当前智能体繁忙，请稍后再试/);
  for (let session = 20; session < 64; session++) send(`s${session}`);
  await settle();
  assert.equal(calls.length, 64);
  send("s65", {
    async replyFailure(event) {
      cards.push(event);
      throw Error("card unavailable");
    }
  });
  await settle();
  assert.equal(cards.at(-1).payload.failure.code, "OH-RUN-2003");
  assert.match(texts.at(-1), /OH-RUN-2003/);
  assert.equal(reads.length, 64);
  release();
  for (let i = 0; i < 40 && runtime.status.sessions.length; i++) await settle();
  assert.equal(calls.length, 144);
  assert.equal(runtime.status.workingTasks, 0);
  assert.equal(runtime.status.queuedTasks, 0);
  assert.equal(reads.length, 144);
});
