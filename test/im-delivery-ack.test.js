import test from "node:test";
import assert from "node:assert/strict";
import {
  ImTextSend,
  ImSendError
} from "../packages/octo-runtime-extra-channel-gateway/dist/delivery/text-send.js";
import { ImDeliveryDispatcher } from "../packages/octo-runtime-extra-channel-gateway/dist/delivery/dispatcher.js";
import {
  deliveryNotice,
  deliveryNoticeCard
} from "../packages/octo-runtime-extra-channel-gateway/dist/presentation/delivery-notice.js";
import { assertCanonicalEvent } from "../packages/octo-runtime-protocol/dist/index.js";
import { OctoApiError } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/errors.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { setImmediate as settle } from "node:timers/promises";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const times = [],
    states = [],
    abort = new AbortController();
  const operation = new ImTextSend(
    () => times.push(Date.now()),
    (state) => states.push(state),
    abort.signal
  );
  const outcome = operation.result.catch((error) => error);
  operation.start();
  return { operation, outcome, times, states, abort };
}

test("F27 four sends wait 15s each, then 1/5/10s, and exhaust as unknown at 76s", async (t) => {
  const f = fixture(t);
  for (const delay of [15000, 1000, 15000, 5000, 15000, 10000, 15000]) t.mock.timers.tick(delay);
  assert.deepEqual(f.times, [0, 16000, 36000, 61000]);
  assert.equal((await f.outcome).state, "unknown");
  assert.deepEqual(f.states, ["unknown"]);
});
test("F27 late success cancels the next retry and explicit rejection is permanent", async (t) => {
  const f = fixture(t);
  t.mock.timers.tick(15000);
  f.operation.ack("confirmed", 1);
  t.mock.timers.tick(100000);
  assert.equal(await f.outcome, "confirmed");
  assert.deepEqual(f.times, [0]);
  const refusal = new ImTextSend(
    () => {},
    () => {},
    new AbortController().signal
  );
  const failed = refusal.result.catch((error) => error);
  refusal.start();
  refusal.ack("0", 2);
  assert.equal((await failed).state, "failed");
});
test("F27 later rejection cannot erase an earlier unknown, abort stops pending retries", async (t) => {
  const f = fixture(t);
  t.mock.timers.tick(15000);
  t.mock.timers.tick(1000);
  f.operation.ack("0", 2);
  assert.equal((await f.outcome).state, "unknown");
  const g = new ImTextSend(
    () => assert.fail("aborted operation sent"),
    () => {},
    AbortSignal.abort()
  );
  const stopped = g.result.catch((error) => error);
  g.start();
  assert.equal((await stopped).code, "IM_DELIVERY_CANCELLED");
  t.mock.timers.tick(100000);
  assert.equal(f.times.length, 2);
});
test("F27 dispatcher does not multiply WS retries and preserves REST uncertainty", async () => {
  const dispatcher = new ImDeliveryDispatcher(new AbortController().signal);
  let count = 0;
  const result = await dispatcher.deliver("text", async () => {
    count++;
    throw new ImSendError("IM_SEND_REJECTED_2", "failed");
  });
  assert.equal(count, 1);
  assert.equal(result.state, "failed");
  count = 0;
  const unknown = await dispatcher.deliver("card", async () => {
    if (++count === 1) throw Error("network");
    throw new OctoApiError({ status: 403, path: "/fixture", body: "denied", retryAfterMs: 0 });
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(count, 2);
  const notice = deliveryNotice();
  assertCanonicalEvent(notice);
  assert.equal(notice.type, "message.create");
  assert.equal(notice.payload.failure.code, "OH-RUN-2005");
  assert.equal(notice.payload.failure.stage, "channel_delivery");
  const card = deliveryNoticeCard(notice);
  assert.match(JSON.stringify(card), /回复送达结果未知/);
  assert.equal(card.actions, undefined);
});

for (const terminal of ["run.completed", "run.cancelled"]) {
  test(`F27 ${terminal} is not rewritten or rerun when reply is unknown; notice failure does not recurse`, async (t) => {
    let receive,
      invokes = 0,
      notices = 0,
      sends = 0;
    t.mock.method(GatewayTransport.prototype, "start", async function () {
      receive = this.callbacks.onMessage;
    });
    t.mock.method(GatewayTransport.prototype, "close", async () => {});
    const runtime = new ImRuntime(
      {
        bot_id: "fixture",
        api_url: "https://im-test.deepminer.com.cn/api",
        adapter: { adapter_type: "codex" }
      },
      {
        host: {
          async *invoke() {
            invokes++;
            yield { protocolVersion: 2, type: terminal, payload: {} };
          },
          async cancel() {
            return { cancelled: true };
          }
        }
      }
    );
    t.after(() => runtime.close());
    await runtime.start();
    receive({
      messageId: "m1",
      senderId: "owner",
      conversationId: "g",
      conversationKind: "group",
      text: "work",
      async buildContext() {
        return { schema: "octo.context-envelope/v3", items: [] };
      },
      async reply() {
        sends++;
        throw new ImSendError("IM_SEND_TIMEOUT", "unknown");
      },
      async replyDeliveryUnknown(event) {
        notices++;
        assert.equal(event.type, "message.create");
        throw new OctoApiError({ status: 403, path: "/fixture", body: "denied", retryAfterMs: 0 });
      }
    });
    for (let i = 0; i < 40; i++) await settle();
    assert.equal(invokes, 1);
    assert.equal(sends, 1);
    assert.equal(notices, terminal === "run.completed" ? 1 : 0);
    assert.equal(runtime.status.workingTasks, 0);
  });
}
