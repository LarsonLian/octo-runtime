import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { startDaemonServer } from "../packages/octo-runtime-daemon/dist/server.js";
import { invokeDaemonRun } from "../packages/octo-runtime-daemon/dist/runtime/run-stream.js";
import { callDaemon } from "../packages/octo-runtime-daemon/dist/runtime/runtime-contract.js";
import { canonicalEvents } from "../packages/octo-runtime-protocol/dist/index.js";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { prepareInvokeInput } from "../packages/octo-runtime-executor-core/dist/index.js";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import { verifyBotIdentity } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/auth.js";
import { WukongConnection } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";
import { getChannelMessages } from "../packages/octo-runtime-extra-channel-gateway/dist/transport/api/conversations.js";

// 仅操作显式给定的测试账号和本脚本新建的隔离群；不输出凭据或文件签名 URL。
assert.ok(
  process.env.OCTO_CHANNEL_QA_ACCOUNTS,
  "Set OCTO_CHANNEL_QA_ACCOUNTS to a protected account file"
);
const accounts = (await readFile(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "utf8"))
  .split(/(?=Bot Name:)/)
  .slice(1)
  .map((block) => {
    const value = (key) => block.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
    return { id: value("Bot ID"), token: value("Bot Token"), api: value("API Server") };
  });
const [receiver, sender] = accounts.filter((a) => a.token?.startsWith("bf_"));
assert.ok(receiver && sender);
for (const account of [receiver, sender]) {
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
  const identity = await verifyBotIdentity(account.api, account.token, AbortSignal.timeout(15000));
  assert.equal(identity.bot_uid, account.id);
}
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
      {
        env,
        timeout: 30000,
        maxBuffer: 1 << 20
      }
    );
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.equal(result.identity.bot_kind, "user_bot");
    return result.data;
  } catch (error) {
    let code = "CLI_FAILED";
    try {
      code = JSON.parse(error.stderr).error.code;
    } catch {}
    throw new Error(`${args.slice(0, 2).join(" ")}: ${code}`);
  }
}
const directory = await mkdtemp(join(tmpdir(), "octo-channel-live-"));
let daemon;
const socket = join(directory, "daemon.sock");
const activeRuns = new Map();
const host = {
  async *invoke(input, environment) {
    activeRuns.set(input.invocationId, input.runId);
    try {
      yield* canonicalEvents(invokeDaemonRun(socket, input, environment));
    } finally {
      activeRuns.delete(input.invocationId);
    }
  },
  cancel: (id) =>
    callDaemon(socket, {
      method: "agent_run.cancel",
      params: { run_id: activeRuns.get(id) ?? id }
    }),
  respondInteraction: (id, response) =>
    callDaemon(socket, {
      method: "agent_run.respond",
      params: { run_id: activeRuns.get(id) ?? id, response }
    }),
  shutdown: () => daemon?.close()
};
const calls = [],
  diagnostics = [],
  received = [];
const connect = WukongConnection.prototype.connect;
WukongConnection.prototype.connect = function (...args) {
  const receive = this.onMessage;
  this.onMessage = (message) => {
    if (message.channelId === group?.group_no)
      received.push({
        type: message.payload.type,
        text: message.payload.content,
        mention: message.payload.mention
      });
    return receive(message);
  };
  return connect.apply(this, args);
};
let runtime, group;
const report = { endpoint: receiver.api, liveIm: true, realCodexImage: false };
const wait = async (predicate, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Live verification timed out");
};
const send = (channelId, channelType, payload) =>
  cli(sender, ["message", "send"], { channel_id: channelId, channel_type: channelType, payload });
const history = (channelId, channelType) =>
  getChannelMessages({
    apiUrl: receiver.api,
    botToken: receiver.token,
    channelId,
    channelType,
    limit: 100,
    pullMode: 0
  });
async function createTestGroup() {
  if (process.env.OCTO_CHANNEL_QA_GROUP) return { group_no: process.env.OCTO_CHANNEL_QA_GROUP };
  const pages = await fetch("http://localhost:9222/json/list").then((r) => r.json());
  const page = pages.find((p) => p.title === "Octo Work");
  assert.ok(page, "Start the logged-in test Work App for human group creation");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP timeout")), 15000);
      ws.addEventListener("message", (e) => {
        const message = JSON.parse(e.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.result?.exceptionDetails || message.error)
          reject(new Error("Test group creation failed in Work App"));
        else resolve(message.result.result.value);
      });
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            expression: `(async()=>{const c=await window.octoWork.getConfig();if(c.serverUrl!=="https://im-test.deepminer.com.cn")throw Error("TEST_ONLY");return window.octoWork.createImGroup(${JSON.stringify({ name: `Channel_QA_${Date.now()}`, memberUids: [receiver.id, sender.id] })});})()`,
            awaitPromise: true,
            returnByValue: true
          }
        })
      );
    });
    return { group_no: result.channelId };
  } finally {
    ws.close();
  }
}
try {
  const manifest = join(directory, "adapters.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      adapters: [
        {
          type: "codex",
          module: fileURLToPath(
            new URL("../packages/octo-runtime-adapter-codex/dist/index.js", import.meta.url)
          ),
          export: "createCodexAdapter",
          factory: true
        }
      ]
    })
  );
  daemon = await startDaemonServer({
    socketPath: socket,
    manifestPath: manifest,
    homePath: directory,
    hostEntrypoint: fileURLToPath(
      new URL("../packages/octo-runtime-adapter-host/dist/runner.js", import.meta.url)
    )
  });
  assert.ok(daemon.hostProcess.child.pid && daemon.hostProcess.child.pid !== process.pid);
  report.independentHost = true;
  group = await createTestGroup();
  assert.ok(group.group_no);
  report.groupId = group.group_no;
  const members = await cli(receiver, ["group", "members", group.group_no]);
  const human = (Array.isArray(members) ? members : members.members).find(
    (m) => m.robot === 0 || m.robot === false
  );
  assert.ok(human, "The test group must contain its human owner");
  const config = {
    bot_id: receiver.id,
    bf_token: receiver.token,
    api_url: receiver.api,
    group_ids: [group.group_no],
    allowed_sender_ids: [sender.id],
    cards: false,
    typing: false,
    adapter: { adapter_type: "codex", workdir: directory },
    context: {
      schema: "octo.context-envelope/v3",
      items: [
        {
          namespace: "extra.qa",
          name: "image-request",
          guidance:
            "收到图片时，只说明上半部分和下半部分的颜色；处理图片时不要调用工具、修改文件或另发消息。",
          payload: {}
        }
      ]
    }
  };
  runtime = new ImRuntime(config, {
    host: {
      async *invoke(input, environment) {
        const { request } = prepareInvokeInput(input);
        calls.push(request);
        const image = input.inputs.some((part) => part.type === "image");
        if (image || request.prompt.startsWith("QA_MODEL_MENTION")) {
          let answer = "",
            terminal,
            toolEvents = 0;
          for await (const event of host.invoke(input, environment)) {
            if (event.type.startsWith("tool_call.")) toolEvents++;
            if (event.type === "message.update" && event.payload.channel === "final")
              answer = event.payload.text ?? answer;
            if (["run.completed", "run.failed", "run.cancelled"].includes(event.type))
              terminal = event.type;
            yield event;
          }
          if (image) {
            report.realCodexImage =
              terminal === "run.completed" && /蓝|blue/i.test(answer) && /黄|yellow/i.test(answer);
            report.imageTerminal = terminal;
          } else {
            report.modelMentionTerminal = terminal;
            report.modelIdentityToolEvents = toolEvents;
            report.modelFinalMarker = answer.includes(`@[${human.uid}:`);
          }
        } else {
          // 业务编排用可控结果；图片与主动查询点名分支调用真实 Codex。
          yield {
            protocolVersion: 2,
            type: "message.delta",
            payload: { channel: "final", text: `QA_FINAL @[${human.uid}:${human.name}]` }
          };
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        }
      },
      cancel: (...args) => host.cancel(...args),
      respondInteraction: (...args) => host.respondInteraction(...args)
    },
    onDiagnostic: (code) => diagnostics.push(code)
  });
  await runtime.start();
  assert.equal(runtime.status.connected, true);
  const channel = group.group_no;
  for (const [index, mention] of [undefined, { all: 1 }, { humans: 1 }].entries())
    await send(channel, 2, {
      type: 1,
      content: `QA_UNMENTIONED_${index} @${receiver.id} @[${receiver.id}:示例]`,
      ...(mention ? { mention } : {})
    });
  await send(channel, 2, { type: 2, url: "https://127.0.0.1/never-download" });
  for (let i = 0; i < 20; i++)
    await send(channel, 2, { type: 1, content: `QA_HISTORY_${String(i).padStart(2, "0")}` });
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(
    calls.length,
    0,
    JSON.stringify({ calls: calls.map((c) => c.prompt), received: received.slice(0, 6) })
  );
  report.unmentionedRuns = 0;
  await send(channel, 2, { type: 1, content: "QA_TRIGGER", mention: { uids: [receiver.id] } });
  await wait(() => calls.length === 1 && runtime.status.sessions.length === 0);
  const first = calls[0].context.items.find((item) => item.name === "history");
  assert.ok(first);
  assert.ok(first.payload.text.includes("QA_HISTORY_05"));
  assert.ok(first.payload.text.includes("QA_HISTORY_19"));
  assert.ok(!first.payload.text.includes("QA_HISTORY_04"));
  assert.ok(!first.payload.text.includes("QA_TRIGGER"));
  report.historyLatest15 = true;
  const final = (await history(channel, 2)).find(
    (m) => m.from_uid === receiver.id && m.content.startsWith("QA_FINAL")
  );
  assert.ok(final?.payload.mention?.uids.includes(human.uid));
  report.finalMentionStored = true;
  await send(channel, 2, { type: 1, content: "QA_CONTINUE", mention: { ais: 1 } });
  await wait(() => calls.length === 2 && runtime.status.sessions.length === 0);
  assert.ok(!calls[1].context.items.some((item) => item.name === "history"));
  report.aiBroadcastRuns = 1;
  report.serverExpandsAiBroadcastUids = received.some(
    (m) => m.text === "QA_CONTINUE" && m.mention?.uids?.includes(receiver.id)
  );
  await send(channel, 2, { type: 1, content: "/reset", mention: { uids: [receiver.id] } });
  await wait(async () =>
    (await history(channel, 2)).some(
      (m) => m.from_uid === receiver.id && m.content === "会话已经重置"
    )
  );
  await send(channel, 2, { type: 1, content: "QA_AFTER_RESET", mention: { uids: [receiver.id] } });
  await wait(() => calls.length === 3 && runtime.status.sessions.length === 0);
  assert.notEqual(calls[0].agentSessionId, calls[2].agentSessionId);
  assert.equal(calls[0].workdir, calls[2].workdir);
  assert.ok(
    calls[2].context.items.some(
      (item) => item.name === "history" && item.payload.text.includes("QA_CONTINUE")
    )
  );
  report.resetKeepsWorkdirAndOldHistory = true;
  const topic = await cli(sender, ["thread", "create", channel], { name: "Channel_QA_topic" });
  const shortId = topic.short_id ?? topic.thread?.short_id;
  assert.ok(shortId, `Thread response fields: ${Object.keys(topic).join(",")}`);
  await cli(receiver, ["thread", "join", channel, shortId]);
  const topicId = `${channel}____${shortId}`;
  await send(topicId, 5, { type: 1, content: "QA_TOPIC_HISTORY" });
  await send(topicId, 5, { type: 1, content: "QA_TOPIC_TRIGGER", mention: { ais: 1 } });
  await wait(() => calls.length === 4 && runtime.status.sessions.length === 0);
  assert.ok(
    calls[3].context.items.some(
      (item) =>
        item.name === "history" &&
        item.payload.text.includes("QA_TOPIC_HISTORY") &&
        !item.payload.text.includes("QA_HISTORY_")
    )
  );
  report.topicScope = true;
  // 标准 PNG fixture：上半蓝、下半黄，生成与识图均不保存图片上下文。
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512, 0);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = randomBytes(512 * (512 * 3 + 1));
  for (let y = 0; y < 512; y++) {
    pixels[y * 1537] = 0;
    for (let x = 0; x < 512; x++) {
      const p = y * 1537 + 1 + x * 3;
      pixels[p] = (pixels[p] % 64) + (y < 256 ? 0 : 192);
      pixels[p + 1] = (pixels[p + 1] % 64) + (y < 256 ? 0 : 192);
      pixels[p + 2] = (pixels[p + 2] % 64) + (y < 256 ? 192 : 0);
    }
  }
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ]);
  const file = join(directory, "fixture.png");
  assert.ok(png.length > 512 * 1024 && png.length < 2 * 1024 * 1024);
  report.imageBytes = png.length;
  await writeFile(file, png);
  const uploaded = await cli(sender, ["file", "upload", "--file", file]);
  assert.ok(uploaded.url);
  await send(channel, 2, {
    type: 2,
    url: uploaded.url,
    width: 512,
    height: 512,
    mention: { uids: [receiver.id] }
  });
  await wait(() => report.imageTerminal && runtime.status.sessions.length === 0, 180000);
  assert.equal(report.realCodexImage, true);
  await send(channel, 2, {
    type: 1,
    content: `QA_MODEL_MENTION：请使用 octo-cli group members ${channel} 查询成员，确认真人“${human.name}”的 UID。任务完成后请 @ 这位真人，最终回复以 QA_MODEL_MENTION_DONE 开头。只查询当前群，不调用任何消息发送工具，不修改文件。`,
    mention: { uids: [receiver.id] }
  });
  await wait(() => report.modelMentionTerminal && runtime.status.sessions.length === 0, 180000);
  assert.equal(report.modelMentionTerminal, "run.completed");
  assert.ok(report.modelIdentityToolEvents > 0);
  assert.equal(report.modelFinalMarker, true);
  assert.ok(
    (await history(channel, 2)).some(
      (m) =>
        m.from_uid === receiver.id &&
        m.content.startsWith("QA_MODEL_MENTION_DONE") &&
        m.payload.mention?.uids.includes(human.uid)
    )
  );
  report.modelMentionStored = true;
  report.diagnostics = [...new Set(diagnostics)];
  console.log(JSON.stringify(report));
} finally {
  await runtime?.close();
  await host.shutdown();
  WukongConnection.prototype.connect = connect;
  await rm(directory, { recursive: true, force: true });
  // 保留新建测试群用于人工查看消息高亮；不删除账号或现有配置。
  if (group) console.log(JSON.stringify({ retainedTestGroup: group.group_no }));
}
