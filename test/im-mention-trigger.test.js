import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsImMessage,
  mentionsBot
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";

const config = {
  bot_id: "bot",
  api_url: "https://im-test.deepminer.com.cn/api",
  spaceId: "space",
  group_ids: ["group"],
  adapter: { adapter_type: "codex" }
};
const message = (mention, changes = {}) => ({
  messageId: "message",
  channelId: "group",
  channelType: 2,
  fromUid: "owner",
  payload: { type: 1, content: "```md\n@bot @[bot:bot] @所有AI\n```", mention },
  ...changes
});

test("group mention consumes metadata only and supports pure AI broadcasts", () => {
  for (const [mention, expected] of [
    [undefined, false], [null, false], [[], false], ["@bot", false], [{}, false],
    [{ uids: ["bot"] }, true], [{ uids: ["other"] }, false],
    [{ ais: 1 }, true], [{ ais: true }, true],
    [{ ais: "1" }, false], [{ ais: "true" }, false], [{ ais: 0 }, false],
    [{ all: 1 }, false], [{ humans: true }, false],
    [{ ais: 1, all: 1 }, false], [{ ais: true, humans: true }, false],
    [{ ais: 1, all: 1, uids: ["bot"] }, true],
    [{ ais: 1, uids: ["other"] }, true],
    [{ ais: 1, uids: ["bot"] }, true],
    [{ entities: [{ uid: "bot" }] }, false]
  ]) {
    assert.equal(mentionsBot(mention, "bot"), expected, JSON.stringify(mention));
    assert.equal(acceptsImMessage(config, "owner", message(mention)), expected);
    assert.equal(acceptsImMessage(config, "owner", message(mention, {
      channelType: 5, channelId: "group____topic"
    })), expected);
  }
});

test("AI broadcast cannot bypass sender, space, group, self or message identity checks", () => {
  for (const changes of [
    { fromUid: "bot" }, { fromUid: "stranger" }, { channelId: "elsewhere" },
    { channelId: "other____topic", channelType: 5 }, { messageId: "" },
    { channelType: 99 },
    { payload: { type: 1, content: "hi", space_id: "other", mention: { ais: 1 } } }
  ]) assert.equal(acceptsImMessage(config, "owner", message({ ais: 1 }, changes)), false);
  assert.equal(acceptsImMessage(config, "owner", message(undefined, {
    channelId: "owner", channelType: 1
  })), true);
});
