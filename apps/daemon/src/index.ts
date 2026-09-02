#!/usr/bin/env node
import { resolveDaemonRuntimePaths } from "./runtime-options.js";
import { startDaemonServer } from "./server.js";

const runtimePaths = resolveDaemonRuntimePaths();
const app = await startDaemonServer(runtimePaths);
console.error(
  `octo-harness daemon ready pid=${process.pid} socket=${app.runtime.socketPath} ` +
  `adapterHostPid=${app.runtime.adapterHost.pid ?? "unknown"} adapters=${app.runtime.adapters.join(",")}`
);
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  // signal handler 必须立即返回；实际清理仍由同一个 Promise 串行完成。
  void app.close().then(
    () => process.exit(0),
    error => {
      console.error(`octo-harness daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
