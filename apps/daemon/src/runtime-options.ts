import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StandardDaemonOptions } from "./server.js";

export function resolveDaemonRuntimePaths(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): StandardDaemonOptions {
  const defaultHome = process.platform === "win32" && env.LOCALAPPDATA?.trim()
    ? join(env.LOCALAPPDATA.trim(), "OctoRuntime") : join(env.HOME?.trim() || homedir(), ".octo-runtime");
  const home = resolve(option(args, ["--home"], env.OCTO_RUNTIME_HOME ?? defaultHome));
  const socket = process.platform === "win32"
    ? `\\\\.\\pipe\\octo-runtime-${createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16)}`
    : join(home, "sockets", "octo-runtime-daemon.sock");
  return {
    homePath: home,
    pidPath: resolve(option(args, ["--pid-file"], env.OCTO_RUNTIME_PID_FILE ?? join(home, "octo-daemon.pid"))),
    consoleOutput: args.includes("--console"),
    socketPath: option(args, ["--socket"], env.OCTO_RUNTIME_SOCKET ?? socket),
    manifestPath: resolve(option(args, ["--manifest"], env.OCTO_RUNTIME_MANIFEST ?? fileURLToPath(new URL("../../../config/adapters.json", import.meta.url)))),
    hostEntrypoint: resolve(option(args, ["--adapter-host", "--host-entrypoint"], env.OCTO_RUNTIME_ADAPTER_HOST ?? fileURLToPath(new URL("../../adapter-host/dist/index.js", import.meta.url))))
  };
}

export function daemonRuntimeArguments(paths: StandardDaemonOptions): string[] {
  return [
    ...(paths.homePath ? ["--home", paths.homePath] : []),
    ...(paths.pidPath ? ["--pid-file", paths.pidPath] : []),
    ...(paths.consoleOutput ? ["--console"] : []),
    "--socket", paths.socketPath, "--manifest", paths.manifestPath, "--adapter-host", paths.hostEntrypoint
  ];
}

function option(args: string[], names: string[], fallback: string): string {
  for (const name of names) {
    const index = args.indexOf(name);
    if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${name}`);
    return value;
  }
  return fallback;
}
