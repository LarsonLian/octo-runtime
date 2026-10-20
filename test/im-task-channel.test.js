import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-executor-core";
import { failurePayload } from "@mininglamp-oss/octo-runtime-protocol";
import { canonicalEvents, invocationInput } from "@mininglamp-oss/octo-runtime-protocol";
import { spawnAdapterHost } from "@mininglamp-oss/octo-runtime-adapter-host";
import { fileURLToPath } from "node:url";
import { buildReasoningFrame } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/reasoning-frame.js";
const event = (type, payload = {}) => ({ protocolVersion: 2, type, payload });
const failure = () => {
  const payload = failurePayload(
    { httpStatus: 503 },
    {
      stage: "provider.invoke",
      defaultDomain: "provider",
      source: { component: "octo-runtime", adapter: "codex" }
    }
  );
  payload.failure.retryAfterMs = 0;
  return event("run.failed", payload);
};

async function fixture(t, invoke, retry = {}) {
  let receive,
    contextBuilds = 0;
  const calls = [],
    replies = [],
    cards = [],
    cancellations = [];
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = (m) => this.callbacks.onMessage(m);
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const runtime = new ImRuntime(
    {
      bot_id: "fixture",
      api_url: "https://im-test.deepminer.com.cn/api",
      adapter: { adapter_type: "codex", workdir: process.cwd() },
      codex_retry: { initial_delay_ms: 100, max_delay_ms: 100, ...retry }
    },
    {
      host: {
        async *invoke(input, environment) {
          const { request } = prepareInvokeInput(input);
          calls.push(request);
          yield* invoke(request, environment, calls);
        },
        async cancel(id) {
          cancellations.push(id);
          return { cancelled: true };
        },
        async respondInteraction() {}
      }
    }
  );
  await runtime.start();
  t.after(() => runtime.close());
  const send = (text, id = text) =>
    receive({
      messageId: id,
      senderId: "owner",
      conversationId: "chat",
      conversationKind: "direct",
      text,
      async buildContext() {
        contextBuilds++;
        return { schema: "octo.context-envelope/v3", items: [] };
      },
      async reply(text, key) {
        replies.push({ text, key });
      },
      beginPresentation(runId, _diagnostic, controls) {
        const snapshots = [];
        const card = { runId, controls, snapshots, finished: false };
        cards.push(card);
        return {
          update: (snapshot) => snapshots.push(snapshot),
          async finish() {
            card.finished = true;
          }
        };
      }
    });
  const done = async () => {
    for (let i = 0; i < 100 && (!replies.length || runtime.status.sessions.length); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(runtime.status.sessions.length, 0);
  };
  return { runtime, send, done, calls, replies, cards, cancellations, builds: () => contextBuilds };
}

test("IM retries one logical message with one card and one final reply; card stop follows current attempt", async (t) => {
  let release, started;
  const gate = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async function* (_request, environment, calls) {
    if (calls.length === 1) {
      yield event("message.delta", {
        messageId: "old",
        channel: "final",
        text: "partial old answer"
      });
      yield failure();
    } else {
      started();
      await new Promise((resolve) => {
        release = resolve;
        environment.signal.addEventListener("abort", resolve, { once: true });
      });
      yield event("run.cancelled");
    }
  });
  f.send("retry");
  await gate;
  assert.equal(f.cards.length, 1);
  assert.equal(f.builds(), 1);
  assert.equal(f.replies.length, 0);
  assert.equal(
    f.cards[0].snapshots.some((s) => s.terminal),
    false,
    "intermediate failure must not seal the card"
  );
  assert.equal(await f.cards[0].controls.cancel(), true);
  release();
  await f.done();
  assert.equal(f.cancellations[0], f.calls[1].invocationId);
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].text, /已中断/);
  assert.equal(f.replies[0].key, `final:${f.calls[0].runId}`);
  assert.equal(f.cards[0].finished, true);
});

test("reset during backoff stops retry but does not cancel the finished Provider", async (t) => {
  const f = await fixture(
    t,
    async function* () {
      yield failure();
    },
    { initial_delay_ms: 5000, max_delay_ms: 5000 }
  );
  f.send("retry");
  await settle();
  assert.equal(f.calls.length, 1);
  f.send("/reset");
  await f.done();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.cancellations, []);
  assert.equal(f.replies.length, 2);
});

test("active occurrence remains deduplicated after the 120-second window", async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, async function* () {
    await gate;
    yield event("run.completed");
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  f.send("same", "same-id");
  await settle();
  t.mock.timers.tick(15 * 60_000);
  f.send("same", "same-id");
  await settle();
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(15 * 60_000);
  release();
  await f.done();
  assert.equal(f.calls.length, 1);
  f.send("same", "same-id");
  await settle();
  assert.equal(f.calls.length, 1, "completion refreshes the bounded deduplication window");
  assert.match(f.replies.at(-1).text, /已经提交/);
});

test("a successful retry discards partial failed-attempt text", async (t) => {
  const f = await fixture(t, async function* (_request, _environment, calls) {
    yield event("message.delta", {
      messageId: "answer",
      channel: "final",
      text: calls.length === 1 ? "old partial" : "new final"
    });
    yield calls.length === 1 ? failure() : event("run.completed");
  });
  f.send("retry");
  await f.done();
  assert.equal(f.calls.length, 2);
  assert.equal(f.replies.length, 1);
  assert.equal(f.replies[0].text, "new final");
  assert.deepEqual(
    f.cards[0].snapshots.at(-1).attempts.map((a) => a.outcome),
    ["run.failed", "run.completed"]
  );
});

for (const mode of ["normal", "recovered", "silent", "snapshot", "tool", "failed"]) {
  test(`Codex subprocess → Host/RPC → IM: ${mode}`, { timeout: 10000 }, async (t) => {
    const hosted = await spawnAdapterHost({
      entrypoint: fileURLToPath(new URL("../test-support/im-diagnostic-host.mjs", import.meta.url))
    });
    t.after(() => hosted.close());
    const f = await fixture(t, async function* (request, environment) {
      yield* canonicalEvents(
        hosted.client.invokeFrames(invocationInput(request, "canonical", "codex"), environment)
      );
    });
    f.send(`DIAGNOSTIC_QA:${mode}`);
    await f.done();
    assert.equal(f.calls.length, 1, "a diagnostic must not schedule a new invocation");
    assert.equal(f.replies.length, 1);
    assert.equal(f.cards.length, 1);
    assert.equal(f.cards[0].finished, true);
    const snapshot = f.cards[0].snapshots.at(-1);
    const frame = buildReasoningFrame(snapshot, {
      ref: { id: "ai.reasoning-process", version: "0.4.0" },
      maxPayloadBytes: 16384
    });
    if (["silent", "snapshot", "tool"].includes(mode)) {
      assert.equal(snapshot.terminal, "completed");
      assert.equal(snapshot.replyAssessment, "needs_verification");
      assert.match(f.replies[0].text, /请核查任务结果，避免重复执行/);
      assert.match(f.replies[0].text, /Synthetic in-turn diagnostic/);
      assert.doesNotMatch(f.replies[0].text, /old partial|Later diagnostic/);
      assert.equal(frame.state, "stopped");
      assert.equal(await f.cards[0].controls.retry(), false);
      if (mode === "tool") assert.equal(snapshot.toolCallCount, 1);
    } else if (mode === "failed") {
      assert.equal(snapshot.terminal, "failed");
      assert.match(f.replies[0].text, /Synthetic terminal failure/);
    } else {
      assert.equal(snapshot.terminal, "completed");
      assert.equal(snapshot.replyAssessment, "ready");
      assert.equal(f.replies[0].text, `DIAGNOSTIC_QA:${mode}:answer`);
      assert.equal(frame.statusLabel, "已完成");
      assert.equal(!!snapshot.providerDiagnostic, mode === "recovered");
    }
  });
}
