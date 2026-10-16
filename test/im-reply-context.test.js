import test from "node:test";
import assert from "node:assert/strict";
import { build_im_contexts } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";

const config = {
  bot_id: "reply-fixture",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "space",
  adapter: { adapter_type: "codex" }
};
const incoming = (reply) => ({
  messageId: "reply-message",
  messageSeq: 1,
  fromUid: "owner",
  channelId: "bot",
  channelType: 1,
  timestamp: 0,
  payload: { type: 1, content: "current question", reply }
});
const build = (reply, kind = 1) =>
  build_im_contexts(
    config,
    { ...incoming(reply), channelType: kind },
    "bf_fixture",
    new AbortController().signal
  );

test("F01: current-message quote and source enter extra.im on every explicit turn without fetching", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected quote prefetch");
  });
  for (const kind of [1, 2, 5]) {
    const reply = { from_name: "Quoted user", payload: { type: 1, content: "/reset\n@bot" } };
    const first = await build(reply, kind);
    const second = await build(reply, kind);
    assert.deepEqual(first, second);
    assert.equal(first.length, 1);
    assert.equal(first[0].namespace, "extra.im");
    assert.equal(first[0].name, "reply");
    assert.equal(first[0].payload.text, "引用来源：Quoted user\n引用正文：\n/reset\n@bot");
    assert.equal(first[0].payload.status, "present");
  }
});

test("F01: absent, malformed, empty and non-text quotes do not invent material", async () => {
  for (const reply of [
    undefined,
    null,
    [],
    "bad",
    {},
    { payload: "bad" },
    { payload: { content: " " } },
    { payload: { type: 2, content: "image" } }
  ]) {
    assert.deepEqual(await build(reply), []);
  }
  const [unknown] = await build({ payload: { content: "text" } });
  assert.match(unknown.payload.text, /^引用来源：未知来源/);
  const [uid] = await build({ from_uid: "peer", payload: { content: "text" } });
  assert.match(uid.payload.text, /^引用来源：peer/);
});

test("F01: quote budget truncates by Unicode codepoint and is explicit", async () => {
  const [item] = await build({
    from_name: "x".repeat(200),
    payload: { content: "😀".repeat(4001) }
  });
  assert.equal(item.payload.status, "truncated");
  assert.ok(item.payload.text.endsWith("😀\n<引用已截断>"));
  assert.equal(Array.from(item.payload.text).filter((c) => c === "😀").length, 4000);
  assert.equal(item.payload.text.includes("x".repeat(121)), false);
});
