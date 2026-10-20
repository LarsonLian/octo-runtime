// 企业微信回归：验证鉴权/心跳、连接替换、消息映射及思考帧到最终回复的 ACK 顺序。
// 客户端是否显示原生气泡仍以真实平台验收记录为准。
import test from "node:test";
import { prepareInvokeInput } from "@mininglamp-oss/octo-runtime-executor-core";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setTimeout as delay, setImmediate as settle } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { WecomConnection } from "../packages/octo-runtime-extra-channel-wecom/dist/transport/connection.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-wecom/dist/index.js";
import { WecomStreamSession } from "../packages/octo-runtime-extra-channel-wecom/dist/transport/stream-session.js";
import {
  validateImConfig,
  imBotIdentity
} from "../packages/octo-runtime-extra-channel-wecom/dist/lifecycle/configuration.js";

async function fixture(t, handle, options = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  let socket;
  const frames = [];
  server.on("connection", (ws) => {
    socket = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame);
      handle?.(frame, ws);
    });
  });
  const url = `ws://127.0.0.1:${server.address().port}`;
  const connection = new WecomConnection({
    wsUrl: url,
    heartbeatIntervalMs: 30_000,
    requestTimeoutMs: 300,
    ...options
  });
  t.after(async () => {
    connection.close();
    for (const client of server.clients) client.terminate();
    await new Promise((r) => server.close(r));
  });
  return {
    connection,
    frames,
    url,
    get socket() {
      return socket;
    }
  };
}
const credentials = { appBot: "aib-test", appSecret: "fixture-secret" };
const ack = (frame, ws) =>
  ws.send(JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: "ok" }));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("condition timed out");
}

test("WeCom authenticates then counts matching heartbeat ACKs; secrets stay out of status", async (t) => {
  const f = await fixture(t, ack, { heartbeatIntervalMs: 20 });
  await f.connection.connect(credentials);
  assert.deepEqual(f.frames[0].body, { bot_id: credentials.appBot, secret: credentials.appSecret });
  assert.equal(f.frames[0].cmd, "aibot_subscribe");
  await until(() => f.connection.status.heartbeatAcks >= 2);
  assert.equal(f.connection.status.connected, true);
  assert.ok(f.connection.status.lastHeartbeatAt);
  assert.doesNotMatch(JSON.stringify(f.connection.status), /fixture-secret/);
  f.connection.close();
  const count = f.frames.length;
  await delay(60);
  assert.equal(f.frames.length, count, "close stops heartbeat timers");
});

test("unrelated ACK and callback cannot authenticate the connection", async (t) => {
  const f = await fixture(t, (frame, ws) => {
    ws.send(JSON.stringify({ headers: { req_id: "unrelated" }, errcode: 0 }));
    ws.send(
      JSON.stringify({ cmd: "aibot_msg_callback", headers: frame.headers, errcode: 0, body: {} })
    );
  });
  await assert.rejects(f.connection.connect(credentials), /WECOM_AUTH_TIMEOUT/);
  assert.equal(f.connection.status.connected, false);
  assert.equal(f.connection.status.heartbeatAcks, 0);
});

test("authentication errors omit server text and credentials", async (t) => {
  const f = await fixture(t, (frame, ws) =>
    ws.send(
      JSON.stringify({ headers: frame.headers, errcode: 40001, errmsg: credentials.appSecret })
    )
  );
  await assert.rejects(f.connection.connect(credentials), { message: "WECOM_AUTH_REJECTED_40001" });
  assert.doesNotMatch(JSON.stringify(f.connection.status), /fixture-secret/);
});

test("missing heartbeat ACK makes the connection offline", async (t) => {
  const f = await fixture(t, (frame, ws) => {
    if (frame.cmd === "aibot_subscribe") ack(frame, ws);
  });
  await f.connection.connect(credentials);
  await assert.rejects(f.connection.ping(), /WECOM_HEARTBEAT_TIMEOUT/);
  assert.equal(f.connection.status.connected, false);
});

test("server replacement closes the old connection without reconnecting", async (t) => {
  const f = await fixture(t, ack);
  await f.connection.connect(credentials);
  f.socket.send(
    JSON.stringify({
      cmd: "aibot_event_callback",
      body: { event: { eventtype: "disconnected_event" } }
    })
  );
  await until(() => !f.connection.status.connected);
  assert.equal(f.connection.status.error, "WECOM_CONNECTION_REPLACED");
});

test("typed IM config keeps execution settings optional and rejects platform field mixing", () => {
  const config = {
    bot_id: credentials.appBot,
    app_secret: credentials.appSecret,
    adapter: { workdir: process.cwd() }
  };
  validateImConfig(config);
  assert.throws(() => validateImConfig({ ...config, type: "unknown" }), /IM_CONFIG_UNKNOWN_FIELD/);
  assert.throws(
    () => validateImConfig({ ...config, spaceId: "fake-octo-space" }),
    /IM_CONFIG_UNKNOWN_FIELD/
  );
  validateImConfig({ ...config, adapter: { ...config.adapter, adapter_type: "codex" } });
  validateImConfig({ ...config, app_secret: "" });
  assert.throws(
    () => validateImConfig({ ...config, app_secret_file: "secret" }),
    /IM_CONFIG_UNKNOWN_FIELD/
  );
  assert.notEqual(imBotIdentity(config), imBotIdentity({ ...config, bot_id: "other" }));
});

test("shared runtime dispatches WeCom text to Codex and replies using the original req_id", async (t) => {
  const f = await fixture(t, ack);
  const calls = [];
  const runtime = new ImRuntime(
    {
      enabled: true,
      bot_id: credentials.appBot,
      app_secret: credentials.appSecret,
      ws_url: f.url,
      adapter: { adapter_type: "codex", workdir: process.cwd() }
    },
    {
      host: {
        cancel: async () => ({ cancelled: true }),
        respondInteraction: async () => {},
        async *invoke(input, environment) {
          const { adapterType: type, request } = prepareInvokeInput(input);
          request.signal = environment?.signal;
          calls.push(request);
          assert.equal(type, "codex");
          assert.equal(request.context.schema, "octo.context-envelope/v3");
          assert.ok(["hello", "next"].includes(request.prompt));
          assert.equal(request.approvalMode, "full_access");
          yield { type: "run.started", payload: {} };
          yield {
            type: "interaction.requested",
            payload: {
              interactionId: "auto-approved",
              kind: "approval",
              request: {
                policy: { mode: "full_access" },
                operation: { summary: "automatic tool approval" }
              }
            }
          };
          yield {
            type: "interaction.resolved",
            payload: {
              interactionId: "auto-approved",
              status: "resolved",
              outcome: "accepted",
              reasonCode: "full_access_policy"
            }
          };
          await delay(600);
          yield {
            type: "tool_call.create",
            payload: { id: "tool", name: "exec_command", args: { cmd: "secret-command" } }
          };
          await delay(600);
          yield {
            type: "message.update",
            payload: { messageId: "answer", channel: "final", text: "Codex test reply" }
          };
          yield { type: "run.completed", payload: {} };
        }
      }
    }
  );
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.status.connected, true);
  const frame = {
    cmd: "aibot_msg_callback",
    headers: { req_id: "callback-1" },
    body: {
      msgid: "message-1",
      aibotid: credentials.appBot,
      chattype: "single",
      from: { userid: "wecom-member" },
      msgtype: "text",
      text: { content: "hello" }
    }
  };
  f.socket.send(JSON.stringify(frame));
  f.socket.send(JSON.stringify(frame));
  await until(() =>
    f.frames.some((frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish)
  );
  assert.equal(calls.length, 1, "duplicate callback must not execute the model twice");
  const reply = f.frames.find(
    (frame) => frame.cmd === "aibot_respond_msg" && frame.body.stream.finish
  );
  assert.equal(reply.headers.req_id, "callback-1");
  assert.equal(reply.body.stream.content, "Codex test reply");
  const progress = f.frames.filter(
    (frame) => frame.cmd === "aibot_respond_msg" && !frame.body.stream.finish
  );
  assert.equal(progress.length, 1);
  assert.equal(progress[0].body.stream.content, "<think></think>");
  for (const frame of progress) {
    assert.equal(frame.headers.req_id, reply.headers.req_id);
    assert.equal(frame.body.stream.id, reply.body.stream.id);
    assert.doesNotMatch(frame.body.stream.content, /secret-command/);
    assert.doesNotMatch(
      frame.body.stream.content,
      /\/approve|automatic tool approval|等待你的确认/
    );
  }
  const count = f.frames.length;
  await delay(600);
  assert.equal(f.frames.length, count, "no progress after final reply");
  assert.equal(runtime.status.sessions.length, 0);
  const oldSession = calls[0].agentSessionId;
  f.socket.send(
    JSON.stringify({
      ...frame,
      headers: { req_id: "reset-1" },
      body: { ...frame.body, msgid: "reset-1", text: { content: "/reset" } }
    })
  );
  await until(() =>
    f.frames.some((item) => item.headers?.req_id === "reset-1" && item.body?.stream?.finish)
  );
  assert.equal(
    f.frames.find((item) => item.headers?.req_id === "reset-1" && item.body?.stream?.finish).body
      .stream.content,
    "会话已经重置"
  );
  assert.equal(calls.length, 1);
  f.socket.send(
    JSON.stringify({
      ...frame,
      headers: { req_id: "next-1" },
      body: { ...frame.body, msgid: "next-1", text: { content: "next" } }
    })
  );
  await until(() =>
    f.frames.some((item) => item.headers?.req_id === "next-1" && item.body?.stream?.finish)
  );
  assert.notEqual(calls[1].agentSessionId, oldSession);
});

test("WeCom plugin validates Bot lists and honors explicit disabled", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { validateImBots } =
    await import("../packages/octo-runtime-extra-channel-wecom/dist/index.js");
  const home = await mkdtemp(join(tmpdir(), "im-defaults-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bot = {
    bot_id: "test",
    enabled: false,
    app_secret: "secret",
    adapter: { workdir: home }
  };
  validateImBots([bot]);
  const config = bot;
  let reads = 0;
  const runtime = new ImRuntime(config, {
    host: {},
    credentials: async () => {
      reads++;
      return "secret";
    }
  });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(reads, 0);
  assert.equal(runtime.status.connected, false);
});

test("execution Context overrides default adapter and maps reasoning to agentConfig", async () => {
  const { createImInvocation: createChannelInput } =
    await import("../packages/octo-runtime-extra-channel-wecom/dist/execution/dispatcher.js");
  const createImInvocation = (...args) => {
    const result = createChannelInput(...args);
    return { ...result, request: prepareInvokeInput(result.request).request };
  };
  const config = {
    enabled: true,
    bot_id: credentials.appBot,
    app_secret: credentials.appSecret,
    adapter: { adapter_type: "codex", workdir: process.cwd() }
  };
  const message = {
    messageId: "msg",
    senderId: "user",
    conversationId: "chat",
    conversationKind: "direct",
    text: "hello"
  };
  const session = { id: "as_test", generation: 1, pending: 0, tail: Promise.resolve() };
  const context = {
    schema: "octo.context-envelope/v3",
    items: [
      { namespace: "octo.execution", name: "adapter", payload: { type: "claude-code" } },
      { namespace: "octo.execution", name: "model", payload: { reasoning: { effort: "high" } } },
      { namespace: "extra.im", name: "test", payload: { text: "explicit per-event context" } }
    ]
  };
  const { adapterType, request } = createImInvocation(
    config,
    message,
    context,
    "key",
    session,
    new AbortController().signal
  );
  assert.equal(adapterType, "claude-code");
  assert.equal(request.agentConfig.effort, "high");
  assert.equal(request.prompt, "hello");
  assert.equal(request.modelInput, "hello");
  assert.deepEqual(
    request.context.items.filter((x) => x.namespace === "extra.im"),
    context.items.filter((x) => x.namespace === "extra.im")
  );
});

test("IM constructs full_access approval Context for both platforms and honors explicit policies", async () => {
  const { createImInvocation: createChannelInput } =
    await import("../packages/octo-runtime-extra-channel-wecom/dist/execution/dispatcher.js");
  const createImInvocation = (...args) => {
    const result = createChannelInput(...args);
    return { ...result, request: prepareInvokeInput(result.request).request };
  };
  const message = {
    messageId: "m",
    senderId: "u",
    conversationId: "c",
    conversationKind: "direct",
    text: "test"
  };
  const context = { schema: "octo.context-envelope/v3", items: [] };
  for (const type of ["wecom"]) {
    const config = { bot_id: "test", adapter: { workdir: process.cwd() } };
    const invoke = (config, context) =>
      createImInvocation(
        config,
        message,
        context,
        "key",
        { id: "session", generation: 1 },
        new AbortController().signal
      ).request;
    const request = invoke(config, context);
    assert.equal(request.approvalMode, "full_access");
    assert.equal(
      request.context.items.find(
        (item) => item.namespace === "octo.security" && item.name === "approval_policy"
      ).payload.mode,
      "full_access"
    );
    assert.equal(invoke({ ...config, approval_mode: "ask" }, context).approvalMode, "ask");
    assert.equal(
      invoke(config, {
        ...context,
        items: [
          { namespace: "octo.security", name: "approval_policy", payload: { mode: "assisted" } }
        ]
      }).approvalMode,
      "assisted"
    );
  }
  assert.deepEqual(context.items, [], "submitted Context is not mutated");
});

test("WeCom seeds native thinking once without status text or periodic duplicate frames", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1000 });
  const sent = [];
  const stream = new WecomStreamSession(async (id, text, finish) =>
    sent.push({ id, text, finish })
  );
  const presentation = stream.begin(() => assert.fail("unexpected delivery failure"));
  presentation.update({ phase: "thinking", toolCallCount: 0 });
  await settle();
  assert.equal(sent[0].text, "<think></think>");
  t.mock.timers.tick(10_000);
  await settle();
  presentation.update({ phase: "tool", toolCallCount: 2 });
  await settle();
  assert.equal(sent.length, 1);
  assert.ok(sent.every((frame) => !frame.finish));
  stream.close();
  const count = sent.length;
  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(sent.length, count);
});

test("WeCom serializes typing, interaction instructions, and final on one stream", async () => {
  const sent = [];
  let concurrent = 0;
  const stream = new WecomStreamSession(async (id, text, finish) => {
    assert.equal(++concurrent, 1, "one pending ACK per req_id");
    await delay(20);
    sent.push({ id, text, finish });
    concurrent--;
  });
  const presentation = stream.begin(() => assert.fail("unexpected delivery failure"));
  await stream.reply("/respond interaction-id <回答>", "interaction:interaction-id");
  presentation.update({ phase: "waiting", toolCallCount: 1, terminal: "cancelled" });
  await presentation.finish();
  assert.ok(sent.every((frame) => !frame.finish));
  assert.match(sent.at(-1).text, /\/respond interaction-id/);
  await stream.reply("本轮执行已中断。", "final:run");
  assert.equal(sent.at(-1).finish, true);
  assert.equal(new Set(sent.map((frame) => frame.id)).size, 1);
  presentation.update({ phase: "thinking", toolCallCount: 1 });
  await delay(600);
  assert.equal(sent.length, 3);
  stream.close();
});
