import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAdapterHost } from "../packages/octo-runtime-adapter-host/dist/index.js";
import { canonicalEvents } from "../packages/octo-runtime-protocol/dist/index.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import { getChannelMessages } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";
import { CardSession } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/card-session.js";
import { buildReasoningFrame } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/reasoning-frame.js";

// 受控 app-server 故障注入，真实 IM 收发。只接受测试环境和已有 QA 群。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS && process.env.OCTO_CHANNEL_QA_GROUP);
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  })
  .filter((a) => a.token?.startsWith("bf_"));
const [receiver, sender] = accounts;
assert.ok(receiver && sender);
const execute = promisify(execFile);
async function cli(account, args, body) {
  const env = {
    ...process.env,
    OCTO_BOT_TOKEN: account.token,
    OCTO_API_BASE_URL: "https://im-test.deepminer.com.cn"
  };
  delete env.OCTO_BOT_ID;
  delete env.OCTO_PROFILE;
  try {
    const { stdout } = await execute(
      "octo-cli",
      [...args, ...(body ? ["--data", JSON.stringify(body)] : [])],
      { env, timeout: 30000, maxBuffer: 1 << 20 }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    if (result.identity?.bot_kind) assert.equal(result.identity.bot_kind, "user_bot");
    return result.data;
  } catch {
    throw new Error(`Test CLI command failed: ${args.slice(0, 2).join(" ")}`);
  }
}
for (const account of [receiver, sender]) {
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
  await cli(account, ["config", "show"]);
  const identity = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
  assert.equal(identity.bot_uid, account.id);
}
const groupId = process.env.OCTO_CHANNEL_QA_GROUP;
const group = await cli(receiver, ["group", "get", groupId]);
assert.match(group.name, /^Channel_QA_/);
const groupMembers = await cli(receiver, ["group", "members", groupId]);
const members = Array.isArray(groupMembers) ? groupMembers : groupMembers.members;
for (const account of [receiver, sender]) assert.ok(members.some((m) => m.uid === account.id));

const directory = await mkdtemp(join(tmpdir(), "octo-diagnostic-live-"));
const hosted = await spawnAdapterHost({
  entrypoint: fileURLToPath(new URL("../test-support/im-diagnostic-host.mjs", import.meta.url))
});
const calls = [],
  snapshots = [],
  diagnostics = [];
const update = CardSession.prototype.update;
CardSession.prototype.update = function (snapshot) {
  snapshots.push(snapshot);
  return update.call(this, snapshot);
};
const runtime = new ImRuntime(
  {
    bot_id: receiver.id,
    bf_token: receiver.token,
    api_url: receiver.api,
    group_ids: [groupId],
    allowed_sender_ids: [sender.id],
    cards: true,
    typing: false,
    adapter: { adapter_type: "codex", workdir: directory }
  },
  {
    host: {
      async *invoke(input, environment) {
        calls.push(input);
        yield* canonicalEvents(hosted.client.invokeFrames(input, environment));
      },
      cancel: (id) => hosted.client.cancel(id),
      respondInteraction: (id, response) => hosted.client.respondInteraction(id, response)
    },
    onDiagnostic: (code) => diagnostics.push(code)
  }
);
const history = () =>
  getChannelMessages({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId: groupId,
    channelType: 2,
    limit: 100,
    pullMode: 0
  });
const wait = async (predicate) => {
  const end = Date.now() + 30000;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Live diagnostic verification timed out");
};
const report = {
  endpoint: receiver.api,
  groupId,
  provider: "controlled app-server subprocess",
  scenarios: []
};
try {
  await runtime.start();
  assert.equal(runtime.status.state, "online");
  for (const mode of ["normal", "recovered", "silent", "tool", "failed"]) {
    const before = new Set((await history()).map((m) => m.message_id));
    const priorCalls = calls.length;
    await cli(sender, ["message", "send"], {
      channel_id: groupId,
      channel_type: 2,
      payload: {
        type: 1,
        content: `DIAGNOSTIC_QA:${mode} ${Date.now()}`,
        mention: { uids: [receiver.id] }
      }
    });
    const messages = await wait(async () => {
      if (calls.length !== priorCalls + 1 || runtime.status.sessions.length) return;
      const messages = (await history()).filter(
        (m) => !before.has(m.message_id) && m.from_uid === receiver.id
      );
      return messages.some((m) => m.type === 1) ? messages : undefined;
    });
    const text = messages.filter((m) => m.type === 1);
    assert.equal(text.length, 1);
    const cards = messages.filter((m) => m.type === 17);
    assert.equal(
      cards.length,
      1,
      `Expected one live card for ${mode}; diagnostics=${diagnostics.join(",")}`
    );
    const card = cards[0].payload;
    const snapshot = snapshots.filter((s) => s.terminal).at(-1);
    const frame = buildReasoningFrame(snapshot, { ref: card.template_ref, maxPayloadBytes: 16384 });
    const pending = ["silent", "tool"].includes(mode);
    assert.equal(frame.state, pending ? "stopped" : mode === "failed" ? "error" : "completed");
    assert.equal(snapshot.terminal, mode === "failed" ? "failed" : "completed");
    if (pending) {
      assert.match(text[0].content, /请核查任务结果，避免重复执行/);
      assert.match(text[0].content, /Synthetic in-turn diagnostic/);
      assert.match(card.plain, /结果待核查/);
      assert.doesNotMatch(JSON.stringify(card.card), /reasoning_retry/);
    } else if (mode === "failed") {
      assert.match(text[0].content, /Synthetic terminal failure/);
      assert.match(card.plain, /失败/);
    } else {
      assert.equal(text[0].content, `DIAGNOSTIC_QA:${mode}:answer`);
      assert.match(card.plain, /已完成/);
    }
    assert.equal(calls.length, priorCalls + 1);
    report.scenarios.push({
      mode,
      invocations: 1,
      finalReplies: text.length,
      cards: cards.length,
      terminal: snapshot.terminal,
      assessment: snapshot.replyAssessment,
      state: frame.state,
      cardMessageId: cards[0].message_id,
      finalMessageId: text[0].message_id
    });
  }
  assert.deepEqual(diagnostics, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    JSON.stringify({
      completed: report.scenarios,
      calls: calls.length,
      sessions: runtime.status.sessions.length,
      lastSnapshot: snapshots.at(-1) && {
        phase: snapshots.at(-1).phase,
        terminal: snapshots.at(-1).terminal
      },
      diagnostics
    })
  );
  throw error;
} finally {
  await runtime.close();
  await hosted.close();
  CardSession.prototype.update = update;
  await rm(directory, { recursive: true, force: true });
}
