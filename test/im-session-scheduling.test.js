import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-executor-core";

const context = { schema: "octo.context-envelope/v3", items: [] };
const channels = [
  [
    "Octo",
    "gateway",
    "GatewayTransport",
    { api_url: "https://im-test.deepminer.com.cn", bf_token: "bf_fixture" }
  ],
  ["WeCom", "wecom", "WecomTransport", { app_secret: "fixture" }]
];

for (const [name, suffix, transportName, platform] of channels) {
  const { ImRuntime } = await import(
    `../packages/octo-runtime-extra-channel-${suffix}/dist/index.js`
  );
  const { [transportName]: Transport } = await import(
    `../packages/octo-runtime-extra-channel-${suffix}/dist/transport/channel.js`
  );

  async function fixture(t, invoke) {
    let receive;
    t.mock.method(Transport.prototype, "start", async function () {
      receive = (message) => this.callbacks.onMessage(message);
    });
    t.mock.method(Transport.prototype, "close", () => {});
    const calls = [],
      replies = [],
      controls = [],
      diagnostics = [];
    const runtime = new ImRuntime(
      {
        ...platform,
        bot_id: "fixture",
        adapter: { adapter_type: "codex", workdir: process.cwd() }
      },
      {
        host: {
          async *invoke(input, environment) {
            const { request } = prepareInvokeInput(input);
            calls.push(request);
            if (invoke) yield* invoke(request, environment);
            else {
              yield {
                protocolVersion: 2,
                type: "session.update",
                payload: { providerSession: { sessionId: "provider" } }
              };
              yield { protocolVersion: 2, type: "run.completed", payload: {} };
            }
          },
          cancel: async () => ({ cancelled: false }),
          respondInteraction: async () => {}
        },
        onDiagnostic: (code) => diagnostics.push(code)
      }
    );
    t.after(() => runtime.close());
    await runtime.start();
    let sequence = 0;
    const send = (text = "hello", conversationId = "chat", overrides = {}) => {
      receive({
        messageId: `message-${++sequence}`,
        senderId: "owner",
        conversationId,
        conversationKind: "direct",
        text,
        buildContext: async () => context,
        reply: async (text, key) => {
          replies.push({ text, key });
        },
        beginPresentation: (_runId, _diagnostic, value) => {
          controls.push(value);
          return { update() {}, async finish() {} };
        },
        ...overrides
      });
    };
    return { runtime, calls, replies, controls, diagnostics, send };
  }

  test(`${name} serves 10,000 distinct daily sessions without retaining idle schedulers`, async (t) => {
    const f = await fixture(t);
    let warmedHeap;
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    for (let index = 0; index < 10_000; index++) {
      t.mock.timers.tick(8_640);
      f.send("hello", `chat-${index}`);
      await settle();
      assert.equal(f.calls.length, 1, `missing invocation ${index}`);
      assert.equal(f.runtime.status.sessions.length, 0, `scheduler retained after turn ${index}`);
      // The fixture must not retain the product's historical requests or card callbacks either.
      f.calls.length = 0;
      f.controls.length = 0;
      f.replies.length = 0;
      if (global.gc && (index === 999 || index === 9_999)) {
        global.gc();
        const heap = process.memoryUsage().heapUsed;
        if (index === 999) warmedHeap = heap;
        else {
          const growth = heap - warmedHeap;
          t.diagnostic(`GC heap growth after warmup: ${growth} bytes`);
          assert.ok(growth < 8 * 1024 * 1024, `historical sessions retained ${growth} heap bytes`);
        }
      }
    }
    assert.deepEqual(f.diagnostics, []);
  });

  test(`${name} restores business binding after idle cleanup and releases control-only sessions`, async (t) => {
    const f = await fixture(t);
    f.send();
    await settle();
    const first = f.calls[0];
    assert.equal(f.runtime.status.sessions.length, 0);
    f.send("/session");
    await settle();
    assert.match(
      f.replies.at(-1).text,
      new RegExp(`session=${first.agentSessionId} generation=1 run=${first.runId}`)
    );
    f.send();
    await settle();
    assert.equal(f.calls[1].agentSessionId, first.agentSessionId);
    assert.deepEqual(f.calls[1].providerSession, { sessionId: "provider" });
    f.send("/reset");
    f.send("/stop", "unused");
    f.send("/cancel", "another-unused");
    await settle();
    assert.equal(f.runtime.status.sessions.length, 0);
    f.send();
    await settle();
    assert.notEqual(f.calls[2].agentSessionId, first.agentSessionId);
    assert.equal(f.calls[2].sessionGeneration, 2);
    assert.equal(f.calls[2].providerSession, undefined);
    assert.equal(f.runtime.status.sessions.length, 0);
  });

  test(`${name} failed-card retries join the current queue after the old scheduler is released`, async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, async function* (request) {
      if (request.prompt === "blocked") await gate;
      yield {
        protocolVersion: 2,
        type: request.prompt === "fail" ? "run.failed" : "run.completed",
        payload: {}
      };
    });
    f.send("fail");
    await settle();
    const failed = f.controls[0];
    assert.equal(f.runtime.status.sessions.length, 0);
    f.send("/reset");
    f.send("blocked");
    await settle();
    const current = f.calls[1];
    assert.equal(failed.retry("owner", "retry-1"), true);
    await settle();
    assert.equal(f.calls.length, 2, "retry must wait behind the new active invocation");
    assert.equal(await failed.cancel(), false, "old card must not cancel the new invocation");
    release();
    await settle();
    assert.equal(f.calls.length, 3);
    assert.equal(f.calls[2].agentSessionId, current.agentSessionId);
    assert.equal(f.calls[2].sessionGeneration, 2);
    assert.equal(f.runtime.status.sessions.length, 0);
  });

  test(`${name} releases failed preparations and Provider failures without consuming future slots`, async (t) => {
    const f = await fixture(t, async function* () {
      throw new Error("provider disconnected");
    });
    for (let index = 0; index < 200; index++) {
      f.send("hello", `prepare-${index}`, {
        buildContext: async () => {
          throw new Error("context unavailable");
        }
      });
      f.send("hello", `provider-${index}`);
      await settle();
      assert.equal(f.runtime.status.sessions.length, 0);
    }
    assert.equal(f.calls.length, 200);
    assert.ok(!f.diagnostics.includes("IM_SESSION_CAPACITY_EXHAUSTED"));
  });

  test(`${name} keeps queued snapshots across reset and does not retain rejected admissions`, async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, async function* (request) {
      if (request.prompt === "blocked") await gate;
      yield { protocolVersion: 2, type: "run.completed", payload: {} };
    });
    f.send("blocked");
    await settle();
    const old = f.calls[0];
    f.send("queued-before-reset");
    f.send("/reset");
    for (let index = 0; index < 62; index++) f.send(`queued-${index}`);
    f.send("other", "different-chat");
    if (suffix === "gateway") {
      assert.equal(f.runtime.status.sessions.length, 2);
      assert.ok(f.diagnostics.includes("IM_SESSION_QUEUE_FULL"));
    } else {
      assert.equal(f.runtime.status.sessions.length, 1);
      assert.ok(f.diagnostics.includes("IM_INBOUND_CAPACITY_EXHAUSTED"));
    }
    release();
    await settle();
    assert.equal(f.calls.length, suffix === "gateway" ? 6 : 64);
    assert.equal(
      f.calls.find((call) => call.prompt === "queued-before-reset").agentSessionId,
      old.agentSessionId
    );
    const afterReset = f.calls.filter((call) => /^queued-\d/.test(call.prompt));
    assert.ok(afterReset.length > 0);
    assert.ok(
      afterReset.every(
        (call) => call.agentSessionId !== old.agentSessionId && call.sessionGeneration === 2
      )
    );
    assert.equal(f.runtime.status.sessions.length, 0);
  });

  test(`${name} close releases active and queued schedulers`, async (t) => {
    const f = await fixture(t, async function* (_request, environment) {
      await new Promise((resolve) => {
        if (environment.signal.aborted) resolve();
        else environment.signal.addEventListener("abort", resolve, { once: true });
      });
      yield { protocolVersion: 2, type: "run.cancelled", payload: {} };
    });
    f.send("active");
    f.send("queued");
    await settle();
    assert.equal(f.runtime.status.sessions.length, 1);
    await f.runtime.close();
    assert.equal(f.calls.length, 1, "queued invocation must not start during close");
    assert.equal(f.runtime.status.sessions.length, 0);
  });
}
