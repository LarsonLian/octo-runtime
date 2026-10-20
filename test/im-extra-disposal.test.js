import test from "node:test";
import assert from "node:assert/strict";
import { ExtraPlugins } from "../packages/octo-runtime-daemon/dist/index.js";
import { waitFor } from "./runtime-fixture.js";
import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/invoke-input.js";

for (const kind of ["gateway", "wecom"]) {
  const base = `../packages/octo-runtime-extra-channel-${kind}/dist/`;
  const { default: load, name } = await import(`${base}extra.js`);
  const { ImChannelManager } = await import(`${base}lifecycle/manager.js`);
  const { ImRuntime } = await import(`${base}application/im-channel.js`);
  const transport = await import(`${base}transport/channel.js`);
  const Transport = transport.GatewayTransport ?? transport.WecomTransport;
  const bot = (id, enabled = true) => ({
    bot_id: id,
    enabled,
    adapter: { adapter_type: "codex", workdir: process.cwd() },
    ...(kind === "gateway" ? { api_url: "https://im-test.deepminer.com.cn/api" } : {})
  });
  const entry = (bots) => ({ name, config: { bots }, load: async () => ({ name, default: load }) });

  test(`${kind}: injected async contexts reach Host once per accepted turn and preserve the configured persona`, async (t) => {
    let callbacks;
    let calls = 0,
      pendingSignal;
    const requests = [],
      replies = [];
    const persona = {
      namespace: "octo.control",
      name: "instructions",
      payload: { entries: [{ text: "我是明略科技的Octo助理" }] }
    };
    t.mock.method(Transport.prototype, "start", async function () {
      callbacks = this.callbacks;
    });
    t.mock.method(Transport.prototype, "close", async () => {});
    const extras = new ExtraPlugins([], {
      async *invoke(input) {
        assert.equal("agentConfig" in input, false);
        requests.push(prepareInvokeInput(input).request);
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      },
      async cancel() {
        return { cancelled: true };
      }
    });
    const config = {
      ...bot("contexts"),
      context: { schema: "octo.context-envelope/v3", items: [persona] }
    };
    await extras.load(
      { name, default: load },
      { bots: [config] },
      {
        loadContexts: async (value, { signal }) => {
          assert.equal(value.bot_id, "contexts");
          assert.equal(signal.aborted, false);
          await Promise.resolve();
          calls++;
          if (calls === 3) throw new Error("private business I/O failure");
          if (calls === 4) {
            pendingSignal = signal;
            await new Promise((resolve) =>
              signal.addEventListener("abort", resolve, { once: true })
            );
          }
          return calls === 1
            ? []
            : [{ ...persona, payload: { entries: [{ text: "dynamic persona" }] } }];
        }
      }
    );
    t.after(() => extras.close());
    const send = (id, text = "hello") =>
      callbacks.onMessage({
        messageId: id,
        senderId: "sender",
        conversationId: "conversation",
        conversationKind: "direct",
        text,
        buildContext: async (_signal, options) => ({
          schema: config.context.schema,
          items: options.configuredItems
        }),
        reply: async (text) => {
          replies.push(text);
        }
      });
    send("control", "/session");
    await waitFor(() => replies.length === 1);
    assert.equal(calls, 0);
    send("first");
    await waitFor(() => replies.length === 2);
    send("second");
    await waitFor(() => replies.length === 3);
    assert.equal(requests[0].controlInstructions, "我是明略科技的Octo助理");
    assert.equal(requests[1].controlInstructions, "dynamic persona");
    assert.deepEqual(config.context.items, [persona]);
    send("third");
    await waitFor(() => replies.length === 4);
    assert.equal(calls, 3);
    assert.equal(requests.length, 2, "callback failure must not invoke a model");
    assert.doesNotMatch(replies.join("\n"), /private business/);
    send("fourth");
    await waitFor(() => pendingSignal);
    send("stop-preparation", "/stop");
    await waitFor(() => replies.length === 5);
    assert.equal(pendingSignal.aborted, true);
    await extras.unload(name);
    assert.equal(requests.length, 2, "cancelled preparation must not start a model");
  });

  test(
    `${kind}: unloading aborts pending initialization and waits for cleanup`,
    { timeout: 3000 },
    async (t) => {
      let signal, release;
      const cleanup = new Promise((resolve) => {
        release = resolve;
      });
      let closes = 0;
      t.mock.method(Transport.prototype, "start", async function (value) {
        signal = value;
        await new Promise((resolve) => value.addEventListener("abort", resolve, { once: true }));
      });
      t.mock.method(Transport.prototype, "close", async () => {
        closes++;
        await cleanup;
      });
      const extras = new ExtraPlugins([entry([bot("pending")])], {});
      const loading = extras.load(name);
      const result = loading.catch((error) => error);
      await waitFor(() => signal);
      let unloaded = false;
      const unloading = extras.unload(name).then(() => {
        unloaded = true;
      });
      try {
        assert.equal(signal.aborted, true);
        await waitFor(() => closes > 0);
        assert.equal(unloaded, false);
      } finally {
        release();
      }
      await result;
      await unloading;
      assert.equal(extras.status[name].phase, "disposed");
      await extras.close();
    }
  );

  test(`${kind}: manager attempts every cleanup, shares close result and refuses reload after failure`, async (t) => {
    const closed = [];
    t.mock.method(ImRuntime.prototype, "close", function () {
      closed.push(this.config.bot_id);
      if (this.config.bot_id === "broken") throw new Error("private cleanup detail");
      return Promise.resolve();
    });
    const extras = new ExtraPlugins([entry([bot("broken", false), bot("healthy", false)])], {});
    await extras.loadConfigured();
    await assert.rejects(extras.unload(name), /EXTRA_DISPOSE_FAILED/);
    assert.deepEqual(closed, ["broken", "healthy"]);
    assert.equal(extras.status[name].phase, "error");
    assert.doesNotMatch(JSON.stringify(extras.status), /private cleanup detail/);
    await assert.rejects(extras.load(name), /EXTRA_ALREADY_LOADED/);
    await assert.rejects(extras.close(), /EXTRA_DISPOSE_FAILED/);
    assert.deepEqual(closed, ["broken", "healthy"]);
  });

  test(
    `${kind}: repeated runtime and manager close wait for the same cleanup`,
    { timeout: 3000 },
    async (t) => {
      let signal, release;
      const cleanup = new Promise((resolve) => {
        release = resolve;
      });
      t.mock.method(Transport.prototype, "start", async (value) => {
        signal = value;
      });
      t.mock.method(Transport.prototype, "close", () => cleanup);
      const runtime = new ImRuntime(bot("repeat"), { host: {} });
      await runtime.start();
      const first = runtime.close();
      assert.equal(first, runtime.close());
      assert.equal(signal.aborted, true);
      let settled = false;
      void first.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      release();
      await first;
      const manager = new ImChannelManager({ host: {} });
      await manager.upsert(bot("disabled", false));
      const closing = manager.close();
      assert.equal(closing, manager.close());
      await closing;
      await assert.rejects(manager.upsert(bot("late", false)), /IM_MANAGER_CLOSED/);
    }
  );

  test(
    `${kind}: unloading aborts an active invocation and waits for its completion`,
    { timeout: 3000 },
    async (t) => {
      let callbacks, invocationSignal, finish;
      const execution = new Promise((resolve) => {
        finish = resolve;
      });
      const cancelled = [];
      t.mock.method(Transport.prototype, "start", async function () {
        callbacks = this.callbacks;
      });
      const host = {
        async *invoke(_input, options) {
          invocationSignal = options.signal;
          await execution;
        },
        async cancel(id) {
          cancelled.push(id);
        }
      };
      const extras = new ExtraPlugins([entry([bot("active")])], host);
      await extras.loadConfigured();
      callbacks.onMessage({
        messageId: "message-1",
        senderId: "sender",
        conversationId: "conversation",
        conversationKind: "direct",
        text: "test",
        buildContext: async () => ({ schema: "octo.context-envelope/v3", items: [] }),
        reply: async () => {}
      });
      await waitFor(() => invocationSignal);
      const closing = extras.unload(name);
      try {
        await waitFor(() => cancelled.length > 0);
        assert.equal(invocationSignal.aborted, true);
        assert.equal(extras.status[name].phase, "disposing");
      } finally {
        finish();
      }
      await closing;
      assert.equal(extras.status[name].phase, "disposed");
      await extras.close();
    }
  );
}

// Real loopback sockets exercise cancellation during handshake/authentication,
// independently of the prototype fault injection above.
for (const kind of ["gateway", "wecom"]) {
  test(
    `${kind}: close settles an actual pending WebSocket handshake`,
    { timeout: 3000 },
    async () => {
      const { WebSocketServer } = await import("ws");
      const { once } = await import("node:events");
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const url = `ws://127.0.0.1:${server.address().port}`;
      const accepted = once(server, "connection");
      let connection;
      if (kind === "gateway") {
        const { WukongConnection } =
          await import("../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js");
        connection = new WukongConnection(() => {});
      } else {
        const { WecomConnection } =
          await import("../packages/octo-runtime-extra-channel-wecom/dist/transport/connection.js");
        connection = new WecomConnection({ wsUrl: url });
      }
      const starting = connection.connect(
        kind === "gateway"
          ? { ws_url: url, robot_id: "test", im_token: "test" }
          : { appBot: "test", appSecret: "test" }
      );
      const rejected = assert.rejects(starting);
      const [peer] = await accepted;
      const disconnected = once(peer, "close");
      try {
        const close = connection.close();
        assert.equal(close, connection.close());
        await close;
        await rejected;
        await disconnected;
      } finally {
        for (const client of server.clients) client.terminate();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  );
}

test(
  "wecom: Extra unload cancels an actual unacknowledged authentication",
  { timeout: 3000 },
  async () => {
    const { WebSocketServer } = await import("ws");
    const { once } = await import("node:events");
    const { default: load, name } =
      await import("../packages/octo-runtime-extra-channel-wecom/dist/extra.js");
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const accepted = once(server, "connection");
    const extras = new ExtraPlugins(
      [
        {
          name,
          load: async () => ({ name, default: load }),
          config: {
            bots: [
              {
                bot_id: "test",
                app_secret: "test",
                ws_url: `ws://127.0.0.1:${server.address().port}`,
                adapter: { adapter_type: "codex", workdir: process.cwd() }
              }
            ]
          }
        }
      ],
      {}
    );
    const starting = extras.load(name);
    const loaded = starting.catch((error) => error);
    const [peer] = await accepted;
    const disconnected = once(peer, "close");
    try {
      await extras.unload(name);
      await loaded;
      await disconnected;
      assert.equal(extras.status[name].phase, "disposed");
    } finally {
      await extras.close();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
);

test("typing disposal aborts and waits for an in-flight send even after its lease was released", async () => {
  const { TypingController } =
    await import("../packages/octo-runtime-extra-channel-gateway/dist/presentation/typing.js");
  let signal, finish;
  const sending = new Promise((resolve) => {
    finish = resolve;
  });
  const typing = new TypingController(
    async (_address, value) => {
      signal = value;
      await sending;
    },
    () => {}
  );
  const release = typing.acquire({ channelType: 1, channelId: "test" }, "lease");
  release();
  assert.equal(signal.aborted, true);
  let done = false;
  const closing = typing.close();
  assert.equal(closing, typing.close());
  void closing.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  finish();
  await closing;
});
