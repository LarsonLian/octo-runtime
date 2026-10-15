import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { readFile } from "node:fs/promises";
import {
  prepareFinalMention,
  MENTION_GUIDANCE
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/mentions.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { WukongConnection } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";

const members = [
  { uid: "u", name: "李白", robot: 0 },
  { uid: "bot", name: "机器人", robot: 1 }
];

test("only final Markdown text markers convert; examples, escapes and quotes remain verbatim", async () => {
  const examples = [
    "`@[u:李白]`",
    "`` @[u:李白] ``",
    "```md\n@[u:李白]\n```",
    "~~~text\n@[u:李白]\n~~~",
    "    @[u:李白]",
    "> @[u:李白]",
    "\\@[u:李白]",
    "<pre>@[u:李白]</pre>"
  ];
  for (const text of examples) {
    assert.deepEqual(
      await prepareFinalMention(text, () => {
        throw new Error("must not query");
      }),
      { text }
    );
  }
  let queries = 0;
  const text =
    "😀已完成，@[u:旧昵称] 与 @[u:李白]；@[bot:机器人]、@[missing:陌生人]。\n\n```\n@[u:李白]\n```";
  const result = await prepareFinalMention(text, async () => {
    queries++;
    return members;
  });
  assert.equal(queries, 1);
  assert.deepEqual(result.mention.uids, ["u"]);
  assert.equal(result.mention.entities.length, 2);
  assert.equal(result.mention.entities[0].offset, "😀已完成，".length);
  for (const entity of result.mention.entities)
    assert.equal(result.text.slice(entity.offset, entity.offset + entity.length), "@李白");
  assert.ok(result.text.includes("@机器人、@陌生人"));
  assert.ok(result.text.endsWith("```\n@[u:李白]\n```"));
  assert.deepEqual(
    await prepareFinalMention("普通 @李白", async () => {
      throw new Error();
    }),
    { text: "普通 @李白" }
  );
});

test("identity lookup failure and unconfirmed human identity never block the final body or create broadcasts", async () => {
  for (const read of [
    async () => {
      throw new Error("403");
    },
    async () => [{ uid: "u", name: "李白" }],
    async () => null,
    async () => [null],
    async () => members.filter((m) => m.robot)
  ]) {
    assert.deepEqual(await prepareFinalMention("已完成 @[u:李白] @[missing:张三]", read), {
      text: "已完成 @李白 @张三"
    });
  }
  const result = await prepareFinalMention("@[-3:所有AI] @[all:所有人]", async () => members);
  assert.deepEqual(result, { text: "@所有AI @所有人" });
});

test("first Context guidance matches the reviewed example exactly", async () => {
  const example = JSON.parse(
    await readFile(
      new URL(
        "../.octospec/tasks/channel-mention-context/first-context.example.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assert.equal(example.items[0].guidance, MENTION_GUIDANCE);
});

test("transport resolves topic members once and sends mention with final text on the original connection", async (t) => {
  let receive,
    queries = 0;
  const sends = [],
    admitted = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/auth/verify-bot")) return Response.json({ bot_uid: "bot", space_id: "s" });
    if (url.endsWith("/bot/register"))
      return Response.json({
        robot_id: "bot",
        owner_uid: "owner",
        owner_channel_id: "owner",
        ws_url: "wss://im-test.deepminer.com.cn/ws",
        im_token: "fixture"
      });
    if (url.endsWith("/groups/group/members")) {
      queries++;
      return Response.json({ members });
    }
    throw new Error("unexpected request");
  });
  t.mock.method(WukongConnection.prototype, "connect", async function () {
    receive = this.onMessage;
  });
  t.mock.method(WukongConnection.prototype, "close", async () => {});
  t.mock.method(WukongConnection.prototype, "sendText", async function (...args) {
    sends.push(args);
    return "message";
  });
  const transport = new GatewayTransport(
    {
      bot_id: "bot",
      api_url: "https://im-test.deepminer.com.cn/api",
      group_ids: ["group"],
      adapter: { adapter_type: "codex" }
    },
    async () => "bf_fixture",
    { onMessage: (m) => admitted.push(m), onDisconnect() {} }
  );
  await transport.start(new AbortController().signal);
  t.after(() => transport.close());
  const message = {
    messageId: "m",
    fromUid: "owner",
    channelId: "group____topic",
    channelType: 5,
    messageSeq: 10,
    payload: { type: 1, content: "task", mention: { ais: 1 } }
  };
  receive(message);
  assert.equal(admitted.length, 1);
  await admitted[0].reply("@[u:李白]", "progress");
  assert.equal(queries, 0);
  await admitted[0].replyFinal("完成 @[u:李白]", "final:run");
  await admitted[0].replyFinal("完成 @[u:李白]", "final:run");
  assert.equal(queries, 1);
  assert.equal(sends[1][0], "group____topic");
  assert.equal(sends[1][1], 5);
  assert.equal(sends[1][2], "完成 @李白");
  assert.deepEqual(sends[1][5].uids, ["u"]);
  assert.equal(sends[0][5], undefined);
  receive({
    ...message,
    messageId: "ignored",
    payload: { type: 1, content: "```\n@bot @[bot:机器人]\n```" }
  });
  assert.equal(admitted.length, 1);
});

test("application uses final mention conversion only for successful final replies, not progress or failures", async (t) => {
  let receive;
  t.mock.method(GatewayTransport.prototype, "start", async function () {
    receive = (m) => this.callbacks.onMessage(m);
  });
  t.mock.method(GatewayTransport.prototype, "close", async () => {});
  const normal = [],
    final = [];
  const runtime = new ImRuntime(
    {
      bot_id: "bot",
      api_url: "https://im-test.deepminer.com.cn/api",
      adapter: { adapter_type: "codex", workdir: process.cwd() }
    },
    {
      host: {
        async *invoke() {
          yield {
            protocolVersion: 2,
            type: "message.delta",
            payload: { channel: "analysis", text: "@[u:李白]" }
          };
          yield {
            protocolVersion: 2,
            type: "message.delta",
            payload: { channel: "final", text: "完成 @[u:李白]" }
          };
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        async cancel() {
          return { cancelled: false };
        },
        async respondInteraction() {}
      }
    }
  );
  await runtime.start();
  t.after(() => runtime.close());
  receive({
    messageId: "m",
    text: "task",
    senderId: "owner",
    conversationId: "g",
    conversationKind: "group",
    async buildContext() {
      return { schema: "octo.context-envelope/v3", items: [] };
    },
    async reply(text) {
      normal.push(text);
    },
    async replyFinal(text) {
      final.push(text);
    }
  });
  for (let i = 0; i < 40 && runtime.status.sessions.length; i++) await settle();
  assert.deepEqual(final, ["完成 @[u:李白]"]);
  assert.deepEqual(normal, []);
});
