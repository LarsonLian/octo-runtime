#!/usr/bin/env node
// Thin process entrypoint. Resource ownership lives in startDaemonServer(); this
// file only translates process signals into its idempotent close contract.
import { inspect } from "node:util";
import { resolveDaemonRuntimePaths } from "./runtime-options.js";
import { startDaemonServer, type DaemonApplication } from "./server.js";
import { loadCliImConfiguration } from "./im-config.js";

const runtimePaths = resolveDaemonRuntimePaths();
let app: DaemonApplication | undefined;
try {
  app = await startDaemonServer({ ...runtimePaths, ...loadCliImConfiguration(runtimePaths.homePath!) });
} catch (error) {
  const verbose = process.argv.includes("--verbose");
  const message = error instanceof Error ? error.message : String(error);
  console.error(verbose ? inspect(error, { depth: null, colors: false }) : `❌ ${message}`);
  process.exitCode = 1;
}

if (app) {
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    // The signal handler must return immediately; the actual cleanup still runs
    // serially through this single close() promise.
    void app.close().then(
      () => process.exit(0),
      error => {
        console.error("daemon shutdown failed", { error: error instanceof Error ? error.message : String(error) });
        console.error(JSON.stringify({
          event: "daemon.shutdown.failed",
          error: error instanceof Error ? error.message : String(error)
        }));
        process.exit(1);
      }
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}
