#!/usr/bin/env node
// Keep process supervision outside the daemon implementation. The launcher owns
// signal/exit propagation and reports child process startup failures.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { HourlyLogWriter } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { daemonRuntimeArguments, resolveDaemonRuntimePaths } from "./runtime-options.js";

const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));
const runtimePaths = resolveDaemonRuntimePaths();
const managed = process.argv.includes("--managed-logs");
const logs = managed
  ? {
      stdout: new HourlyLogWriter(join(runtimePaths.homePath!, "logs"), "service-out"),
      stderr: new HourlyLogWriter(join(runtimePaths.homePath!, "logs"), "service-err")
    }
  : undefined;
const child = spawn(
  process.execPath,
  [
    entrypoint,
    ...daemonRuntimeArguments(runtimePaths),
    ...(process.argv.includes("--verbose") ? ["--verbose"] : [])
  ],
  {
    argv0: "octo-runtime-daemon",
    env: process.env,
    stdio: managed ? ["ignore", "pipe", "pipe"] : "inherit"
  }
);
child.stdout?.on("data", (chunk: Buffer) => logs?.stdout.write(chunk));
child.stderr?.on("data", (chunk: Buffer) => logs?.stderr.write(chunk));
let drainTimer: NodeJS.Timeout | undefined;
if (managed)
  child.once("exit", () => {
    drainTimer = setTimeout(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }, 1000);
    drainTimer.unref();
  });

const forward = (signal: NodeJS.Signals): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const forwardSigint = (): void => forward("SIGINT");
const forwardSigterm = (): void => forward("SIGTERM");
const forwardSighup = (): void => forward("SIGHUP");
process.once("SIGINT", forwardSigint);
process.once("SIGTERM", forwardSigterm);
process.once("SIGHUP", forwardSighup);

let result: { code: number | null; signal: NodeJS.Signals | null };
try {
  result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    }
  );
} catch (error) {
  console.error("daemon child failed to spawn", {
    error: error instanceof Error ? error.message : String(error)
  });
  throw error;
} finally {
  if (drainTimer) clearTimeout(drainTimer);
  logs?.stdout.close();
  logs?.stderr.close();
}
process.removeListener("SIGINT", forwardSigint);
process.removeListener("SIGTERM", forwardSigterm);
process.removeListener("SIGHUP", forwardSighup);

if (result.code !== null) {
  process.exitCode = result.code;
} else if (result.signal) {
  console.error("daemon child exited from signal", { signal: result.signal });
  // Re-raise the child's signal so service managers observe the original
  // termination semantics instead of a synthetic numeric exit code.
  process.kill(process.pid, result.signal);
}
