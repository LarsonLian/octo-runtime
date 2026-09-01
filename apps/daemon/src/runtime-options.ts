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
    )),
    agentWork: resolveAgentWorkOptions(env)
  };
}

function resolveAgentWorkOptions(env: NodeJS.ProcessEnv): StartDaemonServerOptions["agentWork"] {
  const baseUrl = env.ORBTEX_AGENT_WORK_URL?.trim();
  if (!baseUrl) return undefined;
  const token = requiredEnv(env, "ORBTEX_AGENT_WORK_RUNTIME_TOKEN");
  const tenantId = requiredEnv(env, "ORBTEX_AGENT_WORK_TENANT_ID");
  const subjectId = requiredEnv(env, "ORBTEX_AGENT_WORK_SUBJECT_ID");
  return {
    baseUrl,
    token,
    tenantId,
    subjectId,
    runtimeId: env.ORBTEX_AGENT_WORK_RUNTIME_ID?.trim() || undefined,
    runtimeName: env.ORBTEX_AGENT_WORK_RUNTIME_NAME?.trim() || "orbtex-local",
    fingerprint: env.ORBTEX_AGENT_WORK_FINGERPRINT?.trim() || `orbtex:${process.platform}:${process.arch}`
  };
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when ORBTEX_AGENT_WORK_URL is set`);
  return value;
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
