import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import {
  fetchBotGroups,
  getChannelMessages
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";
import {
  acceptsImMessage,
  mentionsBot
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/normalize.js";

// .octospec/tasks/channel-group-admission/brief.md：仅读取 im-test 的既有 QA 消息，
// 在内存重放准入，不注册 WS、不发送消息、不调用 Provider，不输出正文或凭据。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set protected QA account file path");
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  })
  .filter((account) => account.token?.startsWith("bf_"));
const account = accounts.find((value) => value.api === "https://im-test.deepminer.com.cn/api");
assert.ok(account, "An im-test QA Bot is required");
const principal = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
assert.equal(principal.bot_uid, account.id);
const groups = (await fetchBotGroups({ apiUrl: account.api, botToken: account.token }))
  .filter((group) => group.name.startsWith("Channel_QA_"))
  .slice(0, 8);
assert.ok(groups.length, "An existing Channel_QA_ group is required");
let replay;
for (const group of groups) {
  const history = await getChannelMessages({
    apiUrl: account.api,
    botToken: account.token,
    channelId: group.group_no,
    channelType: 2,
    limit: 100
  });
  const sample = history.find(
    (entry) =>
      entry.message_id &&
      entry.from_uid &&
      entry.from_uid !== "unknown" &&
      entry.from_uid !== account.id &&
      entry.type === 1 &&
      mentionsBot(entry.payload?.mention, account.id)
  );
  if (!sample) continue;
  const message = {
    messageId: sample.message_id,
    messageSeq: sample.message_seq ?? 0,
    fromUid: sample.from_uid,
    channelId: group.group_no,
    channelType: 2,
    timestamp: sample.timestamp,
    payload: sample.payload
  };
  // 本次重放显式授权真实发送者，只隔离群范围差异，不声称该发送者是 Bot owner。
  const config = {
    api_url: account.api,
    bot_id: account.id,
    spaceId: principal.space_id,
    adapter: { adapter_type: "codex" },
    allowed_sender_ids: [sample.from_uid]
  };
  const accept = (overrides, input = message) =>
    acceptsImMessage({ ...config, ...overrides }, "unused-owner", input);
  assert.equal(
    accept({ group_ids: [group.group_no] }),
    true,
    "Explicit group must admit real payload"
  );
  const omitted = accept({});
  assert.equal(omitted, true);
  assert.equal(accept({ group_ids: null }), true);
  assert.equal(accept({ group_ids: [] }), true);
  for (const group_ids of [undefined, null, [], [group.group_no]])
    assert.equal(accept({ groups_enabled: false, group_ids }), false);
  assert.equal(accept({ group_ids: ["outside-this-qa-group"] }), false);
  assert.equal(accept({ allowed_sender_ids: [] }), false);
  assert.equal(
    accept({}, { ...message, payload: { ...message.payload, mention: undefined } }),
    false
  );
  assert.equal(
    accept(
      {},
      { ...message, payload: { ...message.payload, space_id: `${principal.space_id}-other` } }
    ),
    false
  );
  replay = {
    omittedGroupIdsAccepted: omitted,
    explicitGroupAccepted: true,
    nullAndEmptyGroupIdsAccepted: true,
    groupsDisabledRejected: true,
    otherGroupRejected: true,
    unauthorizedSenderRejected: true,
    missingMentionRejected: true,
    otherSpaceRejected: true
  };
  break;
}
assert.ok(replay, "An existing non-self text mention in a Channel_QA_ group is required");
console.log(
  JSON.stringify({
    environment: "im-test",
    evidence: "real-history-payload-replay",
    senderExplicitlyAuthorizedForReplay: true,
    sentMessages: 0,
    modelCalls: 0,
    ...replay
  })
);
