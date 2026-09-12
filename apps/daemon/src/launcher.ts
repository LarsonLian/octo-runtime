#!/usr/bin/env node
// Keep process supervision outside the daemon implementation. The launcher owns
// signal/exit propagation and records failures that happen before the daemon can
// initialize its own lifecycle log.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installCrashReporter,
  LocalObservability
} from "@mininglamp-oss/octo-harness-observability";
import { daemonRuntimeArguments, resolveDaemonRuntimePaths } from "./runtime-options.js";

const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));
const runtimePaths = resolveDaemonRuntimePaths();
const crashReporter = runtimePaths.logging?.fileLog
  ? installCrashReporter({ directory: runtimePaths.logging.directory, component: "launcher" })
  : undefined;
const observability = new LocalObservability({
  ...runtimePaths.logging!,
  component: "launcher"
});
// Resolve once, then serialize the result into child argv. This prevents an
// environment change between launcher and child from splitting their log policy.
const child = spawn(process.execPath, [entrypoint, ...daemonRuntimeArguments(runtimePaths)], {
  argv0: "octo-harness-daemon",
  env: process.env,
  stdio: "inherit"
});
observability.log({
  level: "info",
  scope: "launcher.lifecycle",
  event: "daemon.child.spawned",
  message: "daemon child spawned",
  data: { child_pid: child.pid ?? null, entrypoint }
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
  result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
} catch (error) {
  observability.log({
    level: "error",
    scope: "launcher.lifecycle",
    event: "daemon.child.spawn_failed",
    message: "daemon child failed to spawn",
    data: { error: error instanceof Error ? error.message : String(error) }
  });
  await observability.close();
  throw error;
}
process.removeListener("SIGINT", forwardSigint);
process.removeListener("SIGTERM", forwardSigterm);
process.removeListener("SIGHUP", forwardSighup);

if (result.code !== null) {
  process.exitCode = result.code;
} else if (result.signal) {
  observability.log({
    level: "warn",
    scope: "launcher.lifecycle",
    event: "daemon.child.signalled",
    message: "daemon child exited from signal",
    data: { signal: result.signal }
  });
  await observability.close();
  // Re-raise the child's signal so service managers observe the original
  // termination semantics instead of a synthetic numeric exit code.
  process.kill(process.pid, result.signal);
}
observability.log({
  level: result.code === 0 ? "info" : "error",
  scope: "launcher.lifecycle",
  event: "daemon.child.exited",
  message: "daemon child exited",
  data: { exit_code: result.code }
});
await observability.close();
crashReporter?.close();
