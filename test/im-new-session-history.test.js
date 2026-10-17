import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import {
  build_im_contexts,
  ImRuntime
} from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { historyText } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/contexts.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";

const schema = "octo.context-envelope/v3";
const config = {
  bot_id: "test-history",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "space",
  adapter: { adapter_type: "codex", workdir: process.cwd() }
};
const incoming = { channelId: "g____t", channelType: 5, messageId: "100", messageSeq: 100 };

test("history fetches the closest fifteen older messages in the exact topic and emits text only", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url).endsWith("/md")) return Response.json({}, { status: 404 });
    calls++;
    assert.equal(url, `${config.api_url}/v1/bot/messages/sync`);
    assert.deepEqual(JSON.parse(options.body), {
      channel_id: "g____t",
      channel_type: 5,
      limit: 15,
      start_message_seq: 99,
      end_message_seq: 0,
      pull_mode: 0
    });
    return Response.json({
      messages: [100, 99, 98, 97].map((seq) => ({
        message_id: String(seq),
        message_seq: seq,
        from_uid: "peer",
        payload: {
          type: seq === 98 ? 2 : 1,
          content: seq === 98 ? "image secret" : `text${seq}`,
          url: "https://never-download"
        }
      }))
    });
  });
  const items = await build_im_contexts(
    config,
    incoming,
    "bf_fixture",
    new AbortController().signal,
    { initialSession: true }
  );
  assert.equal(
    items.find((item) => item.name === "history").payload.text,
    "peer：text97\npeer：text99"
  );
  assert.equal(JSON.stringify(items).includes("never-download"), false);
  await build_im_contexts(config, incoming, "bf_fixture", new AbortController().signal, {
    initialSession: false,
    mentionGuidance: true
  });
  assert.equal(calls, 1);
});

test("history trims newest-first with a partial oldest tail, marker and Unicode within 1500 codepoints", () => {
  const text = historyText([
    { type: 1, from_uid: "new", content: "latest" },
    { type: 1, from_uid: "old", content: "😀".repeat(2000) + "TAIL" },
    { type: 1, from_uid: "older", content: "excluded" }
  ]);
  assert.equal(Array.from(text).length, 1500);
  assert.ok(text.startsWith("<历史已截断>😀"));
  assert.ok(text.endsWith("TAIL\nnew：latest"));
  assert.equal(text.includes("excluded"), false);
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text), false);
});

test("history failure, malformed result, missing sequence and budget overflow continue without history; cancellation propagates", async (t) => {
  const incoming = { channelId: "peer", channelType: 1, messageId: "100", messageSeq: 100 };
  for (const response of [
    () => Response.json({}, { status: 403 }),
    () => Response.json({ messages: "bad" })
  ]) {
    t.mock.method(globalThis, "fetch", async () => response());
    const items = await build_im_contexts(
      config,
      incoming,
      "bf_fixture",
      new AbortController().signal,
      { initialSession: true }
    );
    assert.equal(
      items.some((item) => item.name === "history"),
      false
    );
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      messages: [{ message_seq: 99, from_uid: "peer", payload: { type: 1, content: "history" } }]
    })
  );
  const full = {
    ...config,
    context: {
      schema,
      items: [{ namespace: "extra.test", name: "large", payload: { text: "x".repeat(65280) } }]
    }
  };
  const items = await build_im_contexts(
    full,
    incoming,
    "bf_fixture",
    new AbortController().signal,
    { initialSession: true }
  );
  assert.equal(items.length, 1);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    build_im_contexts(config, incoming, "bf_fixture", abort.signal, { initialSession: true })
  );
});

test("session initialization is attempted once without a Provider binding, including queued reset races and failed preparation", async (t) => {
  let receive, release;
  const initializations = [],
    guidance = [],
    calls = [],
    replies = [];
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = (m) => this.callbacks.onMessage(m);
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const runtime = new ImRuntime(config, {
    host: {
      async *invoke(input) {
        calls.push(input);
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
      },
      async cancel() {
        return { cancelled: false };
      },
      async respondInteraction() {}
    }
  });
  await runtime.start();
  t.after(() => runtime.close());
  let sequence = 0;
  const send = (id, build) =>
    receive({
      messageId: `${id}-${++sequence}`,
      senderId: "peer",
      conversationId: "chat",
      conversationKind: "direct",
      text: id,
      async buildContext(_signal, options) {
        initializations.push([id, options.initialSession]);
        guidance.push(options.mentionGuidance);
        if (build) await build();
        return { schema, items: [] };
      },
      async reply(text) {
        replies.push(text);
      }
    });
  send(
    "first",
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  await settle();
  send("queued-old");
  send("/reset");
  send("new");
  release();
  for (let i = 0; i < 30 && runtime.status.sessions.length; i++) await settle();
  assert.deepEqual(initializations, [
    ["first", true],
    ["queued-old", false],
    ["new", true]
  ]);
  send("continuation");
  for (let i = 0; i < 30 && runtime.status.sessions.length; i++) await settle();
  assert.deepEqual(initializations.at(-1), ["continuation", false]);
  assert.equal(calls[2].sessionId, calls[3].sessionId);
  assert.notEqual(calls[0].sessionId, calls[2].sessionId);
  send("/reset");
  send("failed", () => {
    throw new Error("fixture");
  });
  for (let i = 0; i < 30 && runtime.status.sessions.length; i++) await settle();
  send("after-failure");
  for (let i = 0; i < 30 && runtime.status.sessions.length; i++) await settle();
  assert.deepEqual(initializations.slice(-2), [
    ["failed", true],
    ["after-failure", false]
  ]);
  assert.ok(
    guidance.every(Boolean),
    "without a Provider binding the short guide is explicit on each new invoke"
  );
});
