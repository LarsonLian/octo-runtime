import test from "node:test";
import assert from "node:assert/strict";
import { messageContent } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/message-content.js";
import { acceptsImMessage } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";
import { build_im_contexts } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
const config = {
  bot_id: "bot",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "space",
  adapter: { adapter_type: "codex" },
  group_ids: ["group"]
};
const message = (payload) => ({
  messageId: "new-message",
  fromUid: "owner",
  channelId: "group",
  channelType: 2,
  timestamp: 0,
  payload
});
const rich = {
  type: 14,
  content: [
    { type: "text", text: "第一段\n" },
    { type: "image", url: "https://example.invalid/a.png" },
    { type: "text", text: "\n第二段" }
  ]
};
const forward = {
  type: 11,
  users: [{ uid: "a", name: "甲" }],
  msgs: [
    { from_uid: "a", payload: { type: 1, content: "/reset\n原发言" } },
    { from_uid: "b", payload: { type: 11, msgs: [{ payload: { type: 14, plain: "内层富文本" } }] } }
  ]
};
test("F02 rich text uses supplied plain or ordered supported blocks without reading images", () => {
  const result = messageContent(rich);
  assert.equal(result.text, "第一段\n[图片，未读取内容]\n第二段");
  assert.equal(result.status, "present");
  assert.equal(messageContent({ ...rich, plain: "服务端正文" }).text, "服务端正文");
  assert.equal(
    messageContent({ type: 14, content: [{ type: "custom", text: "DO_NOT_GUESS" }] }),
    undefined
  );
  assert.equal(messageContent({ type: 14, content: { text: "DO_NOT_GUESS" } }), undefined);
});
test("F02 forwards preserve order, supplied sources and nesting, with unsupported media explicit", () => {
  const result = messageContent(forward);
  assert.match(result.text, /来源：甲\n\/reset\n原发言/);
  assert.match(result.text, /来源：b\n\[合并转发/);
  assert.match(result.text, /来源：未知来源\n内层富文本/);
  assert.ok(result.text.indexOf("原发言") < result.text.indexOf("内层富文本"));
  const mixed = messageContent({
    type: 11,
    msgs: [
      { payload: { type: 1, content: "正文" } },
      { payload: { type: 17, plain: "hidden-card-text" } },
      { payload: { type: 2, url: "https://example.invalid/a.png" } }
    ]
  });
  assert.match(mixed.text, /未支持的消息类型/);
  assert.match(mixed.text, /图片，未读取内容/);
  assert.doesNotMatch(mixed.text, /hidden-card-text|https:/);
});
test("F02 bounds Unicode text, total nodes and nested expansion with explicit truncation", () => {
  const result = messageContent({ type: 14, plain: "😀".repeat(13000) });
  assert.equal(Array.from(result.text.split("\n")[0]).length, 12000);
  assert.equal(result.status, "truncated");
  assert.equal(result.text.includes("\uFFFD"), false);
  assert.match(result.text, /已截断/);
  const many = messageContent({
    type: 11,
    msgs: Array.from({ length: 1000 }, () => ({ payload: { type: 1, content: "a" } }))
  });
  assert.equal(many.status, "truncated");
  assert.ok(many.text.length < 12000);
  let nested = { type: 1, content: "unreachable" };
  for (let i = 0; i < 20; i++) nested = { type: 11, msgs: [{ payload: nested }] };
  const deep = messageContent({
    type: 11,
    msgs: [{ payload: { type: 1, content: "root" } }, { payload: nested }]
  });
  assert.equal(deep.status, "truncated");
  assert.doesNotMatch(deep.text, /unreachable/);
  assert.match(deep.text, /嵌套内容已省略/);
});
test("F02 only outer authorization and mentions admit a new complex message", () => {
  assert.equal(acceptsImMessage(config, "owner", message(forward)), false);
  assert.equal(
    acceptsImMessage(config, "owner", message({ ...forward, mention: { uids: ["bot"] } })),
    true
  );
  for (const change of [{ fromUid: "stranger" }, { fromUid: "bot" }, { channelId: "other" }])
    assert.equal(
      acceptsImMessage(config, "owner", {
        ...message({ ...rich, mention: { uids: ["bot"] } }),
        ...change
      }),
      false
    );
  assert.equal(
    acceptsImMessage(
      config,
      "owner",
      message({
        type: 11,
        msgs: [{ payload: { type: 1, content: "@bot", mention: { uids: ["bot"] } } }]
      })
    ),
    false
  );
  for (const payload of [
    { type: 11, msgs: [] },
    { type: 14, plain: " " },
    { type: 14, content: [{ type: "image" }] }
  ])
    assert.equal(acceptsImMessage(config, "owner", { ...message(payload), channelType: 1 }), false);
});
test("F02 new-message materials use Context v3 and never fetch or expand history", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw Error("unexpected fetch");
  });
  for (const payload of [rich, forward]) {
    const items = await build_im_contexts(
      config,
      { ...message(payload), channelType: 1 },
      "bf_fixture",
      new AbortController().signal
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].namespace, "extra.im");
    assert.equal(items[0].name, "message-content");
    assert.equal(items[0].payload.messageId, "new-message");
    assert.equal(items[0].payload.senderId, "owner");
    assert.deepEqual(items[0].payload.source, {
      service: config.api_url,
      spaceId: "space",
      botId: "bot",
      channelId: "group",
      channelType: 1
    });
  }
  assert.deepEqual(
    await build_im_contexts(
      config,
      { ...message({ type: 1, content: "ordinary" }), channelType: 1 },
      "bf_fixture",
      new AbortController().signal
    ),
    []
  );
});
