#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { daemonRuntimeArguments, resolveDaemonRuntimePaths } from "./runtime-options.js";

const entrypoint = fileURLToPath(new URL("./index.js", import.meta.url));
const runtimePaths = resolveDaemonRuntimePaths();
const child = spawn(process.execPath, [entrypoint, ...daemonRuntimeArguments(runtimePaths)], {
  argv0: "octo-harness-daemon",
  env: process.env,
  stdio: "inherit"
});

const forward = (signal: NodeJS.Signals): void => {
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
};
const forwardSigint = (): void => forward("SIGINT");
const forwardSigterm = (): void => forward("SIGTERM");
process.once("SIGINT", forwardSigint);
process.once("SIGTERM", forwardSigterm);

const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveExit({ code, signal }));
});
process.removeListener("SIGINT", forwardSigint);
process.removeListener("SIGTERM", forwardSigterm);

if (result.code !== null) {
  process.exitCode = result.code;
} else if (result.signal) {
  process.kill(process.pid, result.signal);
}
