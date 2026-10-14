// 动态接入回归：证明 SDK/RPC 可独立更新一个 Bot，且 Daemon 不读取客户 Home 配置。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemonServer } from "@mininglamp-oss/octo-harness-daemon";
import { createImModule } from "@mininglamp-oss/octo-harness-channel-im/daemon-module";
import { callDaemon } from "../packages/octo-harness-daemon/dist/runtime/runtime-contract.js";

test("Daemon IM RPC dynamically manages one endpoint and never discovers client Home files", async (t) => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const home = await mkdtemp(join(tmpdir(), "oh-im-rpc-"));
  await writeFile(join(home, "im.json"), "invalid customer-owned file");
  const socketPath = join(home, "daemon.sock");
  const app = await startDaemonServer({
    homePath: home,
    modules: [{ id: "channel-im", create: createImModule }],
    socketPath,
    storePath: join(home, "state.db"),
    manifestPath: join(root, "test/fixtures/adapters.json"),
    hostEntrypoint: join(root, "apps/adapter-host/dist/index.js")
  });
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  await callDaemon(socketPath, { method: "module.start", params: { id: "channel-im", config: {} } });
  const rpc = (method, params) => method === "status" ? callDaemon(socketPath, { method }) : callDaemon(socketPath, { method: "module.request", params: { id: "channel-im", method: method.slice(3), params } });
  assert.deepEqual(await rpc("im.status"), []);
  const config = {
    type: "octo",
    id: "bot",
    enabled: true,
    apiUrl: "http://127.0.0.1:1",
    botId: "bot",
    spaceId: "space",
    workdir: home
  };
  const first = await rpc("im.upsert", { config });
  assert.equal(first.state, "waiting_credentials");
  const secondConfig = { ...config, id: "other", botId: "other" };
  await rpc("im.upsert", { config: secondConfig });
  const status = await rpc("status");
  const hostPid = status.adapterHost.pid;
  assert.equal((await rpc("im.status")).length, 2);
  await rpc("im.upsert", { config: { ...config, token: "malformed" } });
  assert.equal((await rpc("im.status"))[1].state, "waiting_credentials");
  await rpc("im.remove", { id: "bot" });
  await rpc("im.remove", { id: "bot" });
  assert.equal((await rpc("im.status")).length, 1);
  assert.equal((await rpc("status")).adapterHost.pid, hostPid);
  await rpc("im.upsert", { config });
  assert.equal((await rpc("im.status")).length, 2);
  assert.ok((await rpc("im.status")).every(item => !("revision" in item)));
});
