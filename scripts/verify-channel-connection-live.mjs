import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { ImRuntime } from "../packages/octo-runtime-extra-channel-gateway/dist/index.js";
import {
  registerBot,
  WukongConnection
} from "../packages/octo-runtime-extra-channel-gateway/dist/transport/wukong.js";

// 凭据只从显式指定的受保护文件读取；只操作测试 Bot，不改变持久配置或强制抢占连接。
assert.ok(process.env.OCTO_CHANNEL_QA_ACCOUNTS, "Set OCTO_CHANNEL_QA_ACCOUNTS");
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
for (const account of [receiver, sender])
  assert.equal(account.api, "https://im-test.deepminer.com.cn/api");
const directory = await mkdtemp(join(tmpdir(), "octo-connection-live-"));
const fetchOriginal = globalThis.fetch,
  sendOriginal = WebSocket.prototype.send;
const sockets = [];
let blocked = false,
  authAttempts = 0,
  registrations = 0,
  runtime,
  invalid;
const waits = [],
  traces = [],
  started = Date.now();
const report = { endpoint: receiver.api, localFaultInjection: true, realWebSocket: true };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate, timeout = 20000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw Error("Connection verification timed out");
};
const trace = () => {
  const next = {
    state: runtime.status.state,
    error: runtime.status.error,
    connected: runtime.status.connected
  };
  if (JSON.stringify(traces.at(-1)?.value) !== JSON.stringify(next))
    traces.push({ elapsedMs: Date.now() - started, value: next });
};
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
    return result.data;
  } catch {
    throw Error(`Test CLI operation failed: ${args.slice(0, 2).join(" ")}`);
  }
}
globalThis.fetch = async (url, init) => {
  if (String(url) === `${receiver.api}/v1/auth/verify-bot`) {
    authAttempts++;
    if (blocked) {
      waits.push(Date.now());
      throw new TypeError("Controlled network failure");
    }
  }
  if (String(url) === `${receiver.api}/v1/bot/register`) registrations++;
  return fetchOriginal(url, init);
};
WebSocket.prototype.send = function (data, ...args) {
  if (Buffer.isBuffer(data) && data[0] >> 4 === 1) sockets.push(this);
  return sendOriginal.call(this, data, ...args);
};
let timer;
try {
  const config = {
    bot_id: receiver.id,
    api_url: receiver.api,
    bf_token: receiver.token,
    cards: false,
    typing: false,
    group_rules: false,
    ...(process.env.OCTO_CHANNEL_QA_GROUP
      ? { group_ids: [process.env.OCTO_CHANNEL_QA_GROUP] }
      : {}),
    adapter: { adapter_type: "codex", workdir: directory }
  };
  invalid = new ImRuntime(
    { ...config, bf_token: "bf_invalid_connection_verification" },
    { host: {} }
  );
  const before = authAttempts;
  await invalid.start();
  assert.equal(invalid.status.state, "failed");
  assert.equal(invalid.status.error, "IM_AUTH_HTTP_401");
  await sleep(35000);
  assert.equal(authAttempts, before + 1);
  report.initialFailureNoRetry35s = true;
  console.error("verified: initial failure does not retry for 35s");
  await invalid.close();

  const calls = [];
  const marker = `CONNECTION_QA_${randomUUID()}`;
  runtime = new ImRuntime(
    { ...config, allowed_sender_ids: [sender.id] },
    {
      host: {
        async *invoke() {
          calls.push(marker);
          yield {
            protocolVersion: 2,
            type: "message.delta",
            payload: { channel: "final", text: marker }
          };
          yield { protocolVersion: 2, type: "run.completed", payload: {} };
        },
        cancel: async () => ({ cancelled: true }),
        respondInteraction: async () => {}
      }
    }
  );
  await runtime.start();
  trace();
  assert.equal(runtime.status.state, "online", runtime.status.error);
  timer = setInterval(trace, 25);
  // 使用真实服务端连接，再只对这个进程的恢复鉴权请求注入网络故障。
  blocked = true;
  const droppedAt = Date.now();
  sockets.at(-1).terminate();
  await wait(() => runtime.status.state === "retrying");
  await wait(() => waits.length === 5, 110000);
  const intervals = waits
    .slice(0, 5)
    .map((time, index) => time - (index ? waits[index - 1] : droppedAt));
  for (const [index, expected] of [5000, 10000, 20000, 30000, 30000].entries())
    assert.ok(
      Math.abs(intervals[index] - expected) < 2000,
      `Unexpected backoff at ${index}: ${intervals[index]}`
    );
  report.recoveryWaitsMs = intervals;
  console.error(`verified: recovery waits ${intervals.join(",")} ms`);
  blocked = false;
  await wait(() => runtime.status.state === "online", 40000);
  assert.equal(runtime.status.error, null);
  report.recovered = true;
  console.error("verified: real WS recovered");

  const count = waits.length;
  blocked = true;
  const secondDrop = Date.now();
  sockets.at(-1).terminate();
  await wait(() => waits.length > count, 10000);
  report.secondOutageFirstWaitMs = waits[count] - secondDrop;
  assert.ok(Math.abs(report.secondOutageFirstWaitMs - 5000) < 2000);
  console.error("verified: second outage starts at 5s");
  blocked = false;
  await wait(() => runtime.status.state === "online", 15000);

  // 已有专用隔离群才测试收发，不向普通聊天发送探针。
  if (process.env.OCTO_CHANNEL_QA_GROUP) {
    const group = process.env.OCTO_CHANNEL_QA_GROUP;
    const identity = await cli(sender, ["config", "show"]);
    assert.ok(identity);
    await cli(sender, ["message", "send"], {
      channel_id: group,
      channel_type: 2,
      payload: { type: 1, content: marker, mention: { uids: [receiver.id] } }
    });
    await wait(() => calls.length === 1 && runtime.status.sessions.length === 0);
    await wait(async () => {
      const history = await cli(receiver, ["message", "sync"], {
        channel_id: group,
        channel_type: 2,
        limit: 20
      });
      return (history.messages ?? []).some((m) => {
        const payload =
          typeof m.payload === "string"
            ? JSON.parse(Buffer.from(m.payload, "base64").toString("utf8"))
            : m.payload;
        return m.from_uid === receiver.id && payload?.content === marker;
      });
    });
    report.realImReplyAfterRecovery = true;
  }

  // 只在专用 Bot 上核查重复注册/握手，不使用 force_refresh 或抢占参数。
  try {
    const registration = await registerBot(receiver.api, receiver.token);
    const duplicate = new WukongConnection(() => {});
    try {
      await duplicate.connect(registration);
      report.duplicateConnection = "accepted";
    } catch (error) {
      report.duplicateConnection = error.message;
    } finally {
      await duplicate.close();
    }
  } catch (error) {
    report.duplicateConnection = error.message;
  }
  await sleep(100);
  report.originalStateAfterDuplicate = runtime.status.state;
  report.originalErrorAfterDuplicate = runtime.status.error;

  if (runtime.status.state === "online") {
    blocked = true;
    sockets.findLast((s) => s.readyState === WebSocket.OPEN)?.terminate();
    await wait(() => runtime.status.state !== "online");
  }
  await runtime.close();
  const finalAttempts = authAttempts,
    finalRegistrations = registrations;
  await sleep(6000);
  assert.equal(runtime.status.state, "stopped");
  assert.equal(runtime.status.error, null);
  assert.equal(authAttempts, finalAttempts);
  assert.equal(registrations, finalRegistrations);
  report.stopCancelsRecovery = true;
  report.traces = traces;
  report.passed = true;
  console.log(JSON.stringify(report));
} finally {
  clearInterval(timer);
  await runtime?.close().catch(() => {});
  await invalid?.close().catch(() => {});
  globalThis.fetch = fetchOriginal;
  WebSocket.prototype.send = sendOriginal;
  await rm(directory, { recursive: true, force: true });
}
