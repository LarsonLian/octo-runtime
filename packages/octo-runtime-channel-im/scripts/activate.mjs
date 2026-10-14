#!/usr/bin/env node
// 显式激活工具：将选定配置提交到已有 Daemon，供 SDK 宿主联调动态接入。
// 不创建执行宿主；配置交由 manager 校验，凭据只在本机配置/RPC 中传递。
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { loadImBots, configuredCredential } from "../dist/index.js";

// 显式把 im.json 装配到宿主已有的 daemon。不是自动启动，也不是 MCP 连接器配置。
const [home, socketPath] = process.argv.slice(2);
if (!home || !socketPath) throw new Error("usage: activate.mjs <IM config home> <daemon socket>");
async function call(method, params = {}) {
  const socket = createConnection(socketPath);
  try {
    return await new Promise((resolve, reject) => {
      const id = randomUUID();
      let buffer = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("IM_ACTIVATION_TIMEOUT"));
      }, 30_000);
      const settle = (error, value) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      socket.setEncoding("utf8");
      socket.on("error", () => settle(new Error("IM_DAEMON_UNAVAILABLE")));
      socket.on("connect", () =>
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
      );
      socket.on("data", (data) => {
        buffer += data;
        if (buffer.length > 1024 * 1024) return settle(new Error("IM_RPC_TOO_LARGE"));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (response.id !== id) return settle(new Error("IM_RPC_IDENTITY_MISMATCH"));
          settle(response.error ? new Error("IM_ACTIVATION_REJECTED") : undefined, response.result);
        } catch {
          settle(new Error("IM_RPC_INVALID"));
        }
      });
      socket.on("end", () => settle(new Error("IM_RPC_CLOSED")));
    });
  } finally {
    socket.destroy();
  }
}

try {
  const configs = loadImBots(home);
  await call("module.start", { id: "channel-im", config: {} });
  for (const config of configs) {
    const secret = configuredCredential(config);
    let value;
    if (config.type === "octo") {
      const { bf_token_file: _file, ...bot } = config;
      value = { ...bot, bf_token: secret };
    } else {
      const { app_secret_file: _file, ...bot } = config;
      value = { ...bot, app_secret: secret };
    }
    const status = await call("module.request", { id: "channel-im", method: "upsert", params: { config: value } });
    console.log(
      JSON.stringify({
        connection_key: status.connection_key,
        type: status.type,
        state: status.state,
        connected: status.connected,
        error: status.error
      })
    );
  }
} catch (error) {
  console.error(
    error instanceof Error && /^(IM|WECOM)_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "IM_ACTIVATION_FAILED"
  );
  process.exitCode = 1;
}
