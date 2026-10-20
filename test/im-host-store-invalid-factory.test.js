import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// 独立进程以 strict 模式运行；错误地返回 Promise 的 JS 宿主不能使整个应用退出。
for (const mode of ["rejected", "resolved"]) {
  test(`Gateway: invalid ${mode} factory Promise is isolated and its resources are settled`, () => {
    const script = `
      import assert from "node:assert/strict";
      import { ExtraPlugins } from "./packages/octo-runtime-daemon/dist/index.js";
      import * as gateway from "@mininglamp-oss/octo-runtime/extras/channel-gateway";
      import { MemoryImSessionStore } from "./packages/octo-runtime-extra-channel-gateway/dist/index.js";
      import { GatewayTransport } from "./packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
      const mode = ${JSON.stringify(mode)};
      const connections = new Map();
      GatewayTransport.prototype.start = async function () {
        connections.set(this.config.bot_id, this.callbacks);
      };
      GatewayTransport.prototype.close = async () => {};
      let requests = 0, invalidClosed = 0, validClosed = 0;
      const extras = new ExtraPlugins([], {
        async *invoke() {
          requests++;
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() { return { cancelled: true }; }
      });
      const bot = (bot_id) => ({
        bot_id, api_url: "https://example.com/api",
        adapter: { adapter_type: "test", workdir: process.cwd() }
      });
      try {
        await extras.load(gateway, { bots: [bot("invalid"), bot("valid")] }, {
          createSessionStore(config) {
            if (config.bot_id === "invalid") {
              if (mode === "rejected") return Promise.reject(new Error("private factory error"));
              return Promise.resolve({
                read() { assert.fail("invalid async handle must not be used"); },
                save() { assert.fail("invalid async handle must not be used"); },
                reset() { assert.fail("invalid async handle must not be used"); },
                occurrence() { assert.fail("invalid async handle must not be used"); },
                remember() { assert.fail("invalid async handle must not be used"); },
                async close() {
                  await new Promise((resolve) => setImmediate(resolve));
                  invalidClosed++;
                }
              });
            }
            const store = new MemoryImSessionStore();
            const close = store.close.bind(store);
            store.close = () => { validClosed++; close(); };
            return store;
          }
        });
        await new Promise((resolve) => setImmediate(resolve));
        const status = await extras.inspect(gateway.name);
        assert.equal(status.errors.length, 1);
        assert.equal(status.errors[0].config_index, 0);
        assert.match(status.errors[0].error, /^IM_SESSION_STORE_(INVALID|FACTORY_INVALID)$/);
        assert.equal(status.bots.filter((value) => value.state === "config_error").length, 1);
        assert.equal(status.bots.filter((value) => value.state === "online").length, 1);
        assert.equal(connections.has("invalid"), false);
        assert.equal(invalidClosed, mode === "resolved" ? 1 : 0);
        assert.equal(validClosed, 0);
        connections.get("valid").onMessage({
          messageId: "m1", senderId: "sender", conversationId: "chat",
          conversationKind: "direct", text: "hello",
          buildContext: async () => ({ schema: "octo.context-envelope/v3", items: [] }),
          reply: async () => {}
        });
        const deadline = Date.now() + 1000;
        while (!requests && Date.now() < deadline)
          await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests, 1, "valid Bot must continue executing");
        await extras.unload(gateway.name);
        assert.equal(validClosed, 1);
        assert.equal(invalidClosed, mode === "resolved" ? 1 : 0);
      } finally {
        await extras.close();
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--input-type=module", "--eval", script],
      { cwd: fileURLToPath(new URL("../", import.meta.url)), encoding: "utf8", timeout: 15_000 }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
}
