import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartDaemonServerOptions } from "./server.js";

export function resolveDaemonRuntimePaths(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): StartDaemonServerOptions {
  const home = resolve(env.ORBTEX_HOME ?? join(homedir(), ".orbtex"));
  return {
    socketPath: resolve(option(
      args,
      ["--socket"],
      env.ORBTEX_SOCKET ?? join(home, "sockets", "orbtex-daemon.sock")
    )),
    storePath: resolve(option(args, ["--store"], env.ORBTEX_STORE ?? join(home, "state.json"))),
    manifestPath: resolve(option(
      args,
      ["--manifest"],
      env.ORBTEX_MANIFEST ?? fileURLToPath(new URL("../../../config/adapters.json", import.meta.url))
    )),
    hostEntrypoint: resolve(option(
      args,
      ["--adapter-host", "--host-entrypoint"],
      env.ORBTEX_ADAPTER_HOST ?? fileURLToPath(new URL("../../adapter-host/dist/index.js", import.meta.url))
    ))
  };
}

export function daemonRuntimeArguments(paths: StartDaemonServerOptions): string[] {
  return [
    "--socket", paths.socketPath,
    "--store", paths.storePath,
    "--manifest", paths.manifestPath,
    "--adapter-host", paths.hostEntrypoint
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
