import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptsImMessage,
  mentionsBot
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";
import { GatewayTransport } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/channel.js";
import { WukongConnection } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";

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
    [undefined, false],
    [null, false],
    [[], false],
    ["@bot", false],
    [{}, false],
    [{ uids: ["bot"] }, true],
    [{ uids: ["other"] }, false],
    [{ ais: 1 }, true],
    [{ ais: true }, true],
    [{ ais: "1" }, false],
    [{ ais: "true" }, false],
    [{ ais: 0 }, false],
    [{ all: 1 }, false],
    [{ humans: true }, false],
    [{ ais: 1, all: 1 }, false],
    [{ ais: true, humans: true }, false],
    [{ ais: 1, all: 1, uids: ["bot"] }, true],
    [{ ais: 1, uids: ["other"] }, true],
    [{ ais: 1, uids: ["bot"] }, true],
    [{ entities: [{ uid: "bot" }] }, false]
  ]) {
    assert.equal(mentionsBot(mention, "bot"), expected, JSON.stringify(mention));
    assert.equal(acceptsImMessage(config, "owner", message(mention)), expected);
    assert.equal(
      acceptsImMessage(
        config,
        "owner",
        message(mention, {
          channelType: 5,
          channelId: "group____topic"
        })
      ),
      expected
    );
  }
});

test("AI broadcast cannot bypass sender, space, group, self or message identity checks", () => {
  for (const changes of [
    { fromUid: "bot" },
    { fromUid: "stranger" },
    { channelId: "elsewhere" },
    { channelId: "other____topic", channelType: 5 },
    { messageId: "" },
    { channelType: 99 },
    { payload: { type: 1, content: "hi", space_id: "other", mention: { ais: 1 } } }
  ])
    assert.equal(acceptsImMessage(config, "owner", message({ ais: 1 }, changes)), false);
  assert.equal(
    acceptsImMessage(
      config,
      "owner",
      message(undefined, {
        channelId: "owner",
        channelType: 1
      })
    ),
    true
  );
});

test("omitted, null and empty group scopes are unrestricted; nonempty scopes restrict parent groups", () => {
  for (const [groupIds, expected] of [
    [undefined, true],
    [null, true],
    [[], true],
    [["group"], true],
    [["elsewhere"], false]
  ]) {
    const scoped = { ...config };
    delete scoped.group_ids;
    if (groupIds !== undefined) scoped.group_ids = groupIds;
    for (const [channelType, channelId] of [
      [2, "group"],
      [5, "group____topic"]
    ]) {
      const label = JSON.stringify({ groupIds, channelType });
      assert.equal(
        acceptsImMessage(scoped, "owner", message({ uids: ["bot"] }, { channelType, channelId })),
        expected,
        label
      );
      assert.equal(
        acceptsImMessage(scoped, "owner", message({ ais: 1 }, { channelType, channelId })),
        expected,
        label
      );
    }
    assert.equal(
      acceptsImMessage(scoped, "owner", message(undefined, { channelType: 1, channelId: "owner" })),
      true,
      "group scope must not restrict direct messages"
    );
  }
});

test("groups_enabled is independent of group scopes and never disables direct messages", () => {
  for (const enabled of [undefined, true, false]) {
    for (const groupIds of [undefined, null, [], ["group"], ["elsewhere"]]) {
      const scoped = { ...config, groups_enabled: enabled, group_ids: groupIds };
      const expected = enabled !== false && (!groupIds?.length || groupIds.includes("group"));
      for (const [channelType, channelId] of [
        [2, "group"],
        [5, "group____topic"]
      ]) {
        assert.equal(
          acceptsImMessage(scoped, "owner", message({ uids: ["bot"] }, { channelType, channelId })),
          expected,
          JSON.stringify({ enabled, groupIds, channelType })
        );
      }
      assert.equal(
        acceptsImMessage(
          scoped,
          "owner",
          message(undefined, { channelType: 1, channelId: "owner" })
        ),
        true
      );
    }
  }
});

test("omitting group scope does not bypass sender authorization, Space or real mention", () => {
  const unrestricted = { ...config };
  delete unrestricted.group_ids;
  for (const changes of [
    { fromUid: "bot" },
    { fromUid: "stranger" },
    { messageId: "" },
    { channelType: 99 },
    { payload: { type: 1, content: "@bot", mention: { uids: ["bot"] }, space_id: "other" } },
    { payload: { type: 1, content: "@bot" } },
    { payload: { type: 1, content: "@bot", mention: { uids: ["other"] } } }
  ])
    assert.equal(
      acceptsImMessage(unrestricted, "owner", message({ uids: ["bot"] }, changes)),
      false
    );
  assert.equal(
    acceptsImMessage(
      { ...unrestricted, allowed_sender_ids: [] },
      "owner",
      message({ uids: ["bot"] })
    ),
    false
  );
  const authorized = { ...unrestricted, allowed_sender_ids: ["authorized"] };
  assert.equal(acceptsImMessage(authorized, "owner", message({ uids: ["bot"] })), false);
  assert.equal(
    acceptsImMessage(authorized, "owner", message({ uids: ["bot"] }, { fromUid: "authorized" })),
    true
  );
});

test("transport without group_ids admits owner mentions and replies to each original channel", async (t) => {
  let receive;
  const admitted = [],
    sends = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    if (url.endsWith("/auth/verify-bot"))
      return Response.json({ bot_uid: "bot", space_id: "space" });
    if (url.endsWith("/bot/register"))
      return Response.json({
        robot_id: "bot",
        owner_uid: "owner",
        owner_channel_id: "owner",
        ws_url: "wss://im-test.deepminer.com.cn/ws",
        im_token: "fixture"
      });
    throw new Error("unexpected request");
  });
  t.mock.method(WukongConnection.prototype, "connect", async function () {
    receive = this.onMessage;
  });
  t.mock.getter(WukongConnection.prototype, "connected", () => true);
  t.mock.method(WukongConnection.prototype, "close", async () => {});
  t.mock.method(WukongConnection.prototype, "sendText", async (...args) => {
    sends.push(args);
    return "reply-id";
  });
  const withoutGroups = { ...config };
  delete withoutGroups.group_ids;
  for (const overrides of [{}, { group_ids: null }, { group_ids: [] }, { groups_enabled: false }]) {
    const transport = new GatewayTransport(
      { ...withoutGroups, ...overrides },
      async () => "bf_fixture",
      {
        onMessage: (value) => admitted.push(value),
        onDisconnect() {}
      }
    );
    try {
      await transport.start(new AbortController().signal);
      const before = admitted.length;
      for (const [channelType, channelId, kind] of [
        [1, "owner", "direct"],
        [2, "group", "group"],
        [5, "group____topic", "thread"]
      ]) {
        const count = admitted.length;
        receive(
          message({ uids: ["bot"] }, { channelType, channelId, messageId: `m-${channelType}` })
        );
        if (overrides.groups_enabled === false && channelType !== 1) {
          assert.equal(admitted.length, count);
          continue;
        }
        assert.equal(admitted.at(-1)?.conversationId, channelId);
        assert.equal(admitted.at(-1)?.conversationKind, kind);
        await admitted.at(-1).reply("reply", `reply-${channelType}`);
        assert.equal(sends.at(-1)[0], channelId);
        assert.equal(sends.at(-1)[1], channelType);
      }
      receive(message(undefined));
      receive(message({ uids: ["bot"] }, { fromUid: "stranger" }));
      assert.equal(admitted.length - before, overrides.groups_enabled === false ? 1 : 3);
      assert.equal(sends.length, admitted.length);
    } finally {
      await transport.close();
    }
  }
});
