#!/usr/bin/env node
// Daemon entrypoint: resolve runtime paths, start the socket control plane +
// worker, and translate SIGINT/SIGTERM into a single graceful shutdown.
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
  // The signal handler must return immediately; the actual cleanup still runs
  // serially through this single close() promise.
  void app.close().then(
    () => process.exit(0),
    error => {
      console.error(`octo-harness daemon shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  );
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
