#!/usr/bin/env node
// Thin process entrypoint. Resource ownership lives in startDaemonServer(); this
// file only translates process signals into its idempotent close contract.
import { resolveDaemonRuntimePaths } from "./runtime-options.js";
import { startDaemonServer } from "./server.js";

const runtimePaths = resolveDaemonRuntimePaths();
const app = await startDaemonServer(runtimePaths);
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  // The signal handler must return immediately; the actual cleanup still runs
  // serially through this single close() promise.
  void app.close().then(
    () => process.exit(0),
    error => {
      app.observability.log({
        level: "error",
        scope: "daemon.lifecycle",
        event: "daemon.shutdown.failed",
        message: "daemon shutdown failed",
        data: { error: error instanceof Error ? error.message : String(error) }
      });
      // stderr is an emergency channel only. Normal diagnostics stay in the
      // protected log directory, but a failed logger shutdown must remain visible
      // to a supervising process even when the file sink is unavailable.
      console.error(JSON.stringify({
        event: "daemon.shutdown.failed",
        error: error instanceof Error ? error.message : String(error)
      }));
      process.exit(1);
    }
  );
};
process.on("SIGINT", stop); process.on("SIGTERM", stop);
