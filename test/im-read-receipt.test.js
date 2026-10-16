import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";

test("F05: read starts with accepted work, queued and duplicate messages wait; failure is isolated", async (t) => {
  let receive, release;
  const read = [],
    diagnostics = [];
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = this.callbacks.onMessage;
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  let runs = 0;
  const runtime = new ImRuntime(
    {
      bot_id: "fixture",
      api_url: "https://im-test.deepminer.com.cn/api",
      adapter: { adapter_type: "codex" },
      allowed_sender_ids: ["owner"]
    },
    {
      host: {
        async *invoke() {
          runs++;
          if (runs === 1) await gate;
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() {
          return { cancelled: true };
        },
        async respondInteraction() {}
      },
      onDiagnostic: (code) => diagnostics.push(code)
    }
  );
  await runtime.start();
  t.after(() => runtime.close());
  const send = (id, senderId = "owner") =>
    receive({
      messageId: id,
      senderId,
      conversationId: "chat",
      conversationKind: "direct",
      text: "work",
      async markRead() {
        read.push(id);
        if (id === "second") throw Error("offline");
      },
      async buildContext() {
        return { schema: "octo.context-envelope/v3", items: [] };
      },
      async reply() {}
    });
  send("first");
  send("first");
  send("filtered", "other");
  send("second");
  await settle();
  assert.deepEqual(read, ["first"]);
  release();
  for (let i = 0; i < 20 && runtime.status.sessions.length; i++) await settle();
  assert.deepEqual(read, ["first", "second"]);
  assert.equal(runs, 2);
  assert.ok(diagnostics.includes("IM_READ_RECEIPT_FAILED"));
});
