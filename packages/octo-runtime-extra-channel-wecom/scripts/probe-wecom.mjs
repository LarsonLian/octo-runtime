#!/usr/bin/env node
// 连接探针：仅验证真实企业微信鉴权与心跳 ACK，不发送聊天消息或调用模型。
// 探针成功只证明连接可用，不能代替客户端思考气泡与回复验收。
import { readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { WecomConnection } from "../dist/index.js";

// 不接受命令行明文 Secret，避免凭据出现在进程列表中。
const file = process.argv[2];
const connection = new WecomConnection();
const stop = () => connection.close();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  let credentials;
  if (file) {
    const info = statSync(file);
    if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
      throw new Error("WECOM_CREDENTIAL_FILE_REQUIRES_0600");
    credentials = JSON.parse(readFileSync(file, "utf8"));
  } else {
    credentials = { appBot: process.env.WECOM_APP_BOT, appSecret: process.env.WECOM_APP_SECRET };
  }
  await connection.connect(credentials);
  console.log(JSON.stringify({ event: "wecom.authenticated", ...connection.status }));
  const deadline = Date.now() + 75_000;
  let reported = 0;
  while (
    connection.status.connected &&
    connection.status.heartbeatAcks < 2 &&
    Date.now() < deadline
  ) {
    await delay(250);
    const status = connection.status;
    if (status.heartbeatAcks > reported) {
      reported = status.heartbeatAcks;
      console.log(JSON.stringify({ event: "wecom.heartbeat.ack", ...status }));
    }
  }
  if (!connection.status.connected || connection.status.heartbeatAcks < 2)
    throw new Error(connection.status.error ?? "WECOM_PROBE_INCOMPLETE");
  console.log(JSON.stringify({ event: "wecom.probe.passed", ...connection.status }));
} catch (error) {
  // 仅输出本模块受控错误码，不回显 JSON 正文、服务端 errmsg 或文件内容。
  const code =
    error instanceof Error && /^WECOM_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "WECOM_PROBE_FAILED";
  console.error(JSON.stringify({ event: "wecom.probe.failed", code }));
  process.exitCode = 1;
} finally {
  connection.close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
