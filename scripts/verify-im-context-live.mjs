import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build_im_contexts } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import { sendReadReceipt } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/messages.js";
import {
  getChannelMessages,
  fetchBotGroups
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";

// Octospec F01: 仅使用显式指定的测试账号；不输出凭据、正文或签名地址。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS);
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  })
  .filter((account) => account.token?.startsWith("bf_"));
const [receiver, sender] = accounts;
assert.ok(receiver && sender);
for (const account of [receiver, sender]) {
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
  const identity = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
  assert.equal(identity.bot_uid, account.id);
}
const execute = promisify(execFile);
const groups = await Promise.all(
  [receiver, sender].map((account) =>
    fetchBotGroups({ apiUrl: account.api, botToken: account.token })
  )
);
const group = groups[0].find(
  (entry) =>
    entry.name.startsWith("Channel_QA_") &&
    groups[1].some((other) => other.group_no === entry.group_no)
);
assert.ok(group, "An existing isolated Channel_QA_ group shared by both test bots is required");
const marker = `F01_QA_${Date.now()}`;
const resourceTest = process.argv.includes("--resources");
const quoted = {
  from_uid: receiver.id,
  from_name: "引用测试来源",
  payload: { type: 1, content: marker }
};
const env = {
  ...process.env,
  OCTO_BOT_TOKEN: sender.token,
  OCTO_API_BASE_URL: "https://im-test.deepminer.com.cn"
};
delete env.OCTO_BOT_ID;
delete env.OCTO_PROFILE;
let payload = { type: 1, content: marker, reply: quoted };
if (resourceTest) {
  const directory = await mkdtemp(join(tmpdir(), "octo-resource-qa-"));
  try {
    const file = join(directory, `${marker}.txt`);
    await writeFile(file, marker);
    let upload;
    try {
      const { stdout } = await execute("octo-cli", ["file", "upload", "--file", file], {
        env,
        timeout: 30000,
        maxBuffer: 1 << 20
      });
      upload = JSON.parse(stdout).data;
    } catch {
      throw Error("IM_TEST_UPLOAD_FAILED");
    }
    const address = upload?.url ?? upload?.path;
    assert.equal(typeof address, "string", "Uploaded file must have a real address");
    payload = { type: 8, content: marker, name: `${marker}.txt`, url: address };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
try {
  const { stdout } = await execute(
    "octo-cli",
    [
      "message",
      "send",
      "--data",
      JSON.stringify({
        channel_id: group.group_no,
        channel_type: 2,
        payload
      })
    ],
    { env, timeout: 30000, maxBuffer: 1 << 20 }
  );
  assert.equal(JSON.parse(stdout).ok, true);
} catch (error) {
  let code = "CLI_FAILED";
  try {
    code = JSON.parse(error.stderr || error.stdout).error.code;
  } catch {}
  throw new Error(
    `IM_TEST_SEND_FAILED:${String(code)
      .replace(/[^A-Z0-9_]/gi, "")
      .slice(0, 80)}`
  );
}
let received;
for (let attempt = 0; attempt < 10 && !received; attempt++) {
  const messages = await getChannelMessages({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId: group.group_no,
    channelType: 2,
    limit: 30,
    pullMode: 0
  });
  received = messages.find((message) => message.content === marker);
  if (!received) await new Promise((resolve) => setTimeout(resolve, 300));
}
assert.ok(received, "Test message must be visible through the receiver identity");
if (process.argv.includes("--read")) {
  await sendReadReceipt({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId: group.group_no,
    channelType: 2,
    messageIds: [received.message_id],
    signal: AbortSignal.timeout(15000)
  });
  console.log(JSON.stringify({ feature: "F05", readReceiptAccepted: true }));
}
if (!resourceTest) assert.deepEqual(received.payload.reply, quoted);
const envelope = await build_im_contexts(
  {
    bot_id: receiver.id,
    api_url: receiver.api,
    spaceId: "qa",
    adapter: { adapter_type: "codex", workdir: "/tmp" }
  },
  {
    messageId: received.message_id,
    messageSeq: received.message_seq,
    fromUid: sender.id,
    channelId: group.group_no,
    channelType: 2,
    timestamp: received.timestamp,
    payload: received.payload
  },
  receiver.token,
  AbortSignal.timeout(15000)
);
assert.ok(
  envelope.some(
    (item) =>
      item.namespace === "extra.im" &&
      item.name === (resourceTest ? "resources" : "reply") &&
      item.payload.text.includes(marker)
  )
);
console.log(
  JSON.stringify({
    endpoint: receiver.api,
    feature: resourceTest ? "F04" : "F01",
    serverPreservesPayload: true,
    contextProjected: true
  })
);
