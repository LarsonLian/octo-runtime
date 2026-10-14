import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentWorkRuntimeOptions } from "./agent-work-runtime.js";
import { loadManagedAgentWorks } from "./managed-profile.js";
import type { StandardDaemonOptions } from "./server.js";

/**
 * Resolve all daemon runtime paths and options from CLI args and env, defaulting
 * everything under `$OCTO_HARNESS_HOME` (~/.octo-harness). CLI args win over env,
 * env over defaults. Also the single source of truth the CLI uses to locate the
 * daemon socket, so both sides always agree on the path.
 */
export function resolveDaemonRuntimePaths(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): StandardDaemonOptions {
  const home = resolve(option(args, ["--home"], env.OCTO_HARNESS_HOME ?? defaultHarnessHome(env)));
  const requestedProfile = optionalOption(args, ["--profile"], undefined);
  const managed = loadManagedAgentWorks(home, requestedProfile);
  const selectedAgentWorks = managed === undefined
    ? optionalAgentWorks(resolveAgentWorkOptions(args, env, home, undefined))
    : managed
      .map(runtime => resolveAgentWorkOptions(args, env, home, runtime))
      .filter((runtime): runtime is AgentWorkRuntimeOptions => runtime !== undefined);
  return {
    homePath: home,
    pidPath: resolve(option(args, ["--pid-file"], env.OCTO_HARNESS_PID_FILE ?? join(home, "octo-daemon.pid"))),
    consoleOutput: booleanOption(args, "--console", false),
    socketPath: resolve(option(
      args,
      ["--socket"],
      env.OCTO_HARNESS_SOCKET ?? defaultSocketPath(home)
    )),
    storePath: resolve(option(args, ["--store"], env.OCTO_HARNESS_STORE ?? join(home, "state.db"))),
    manifestPath: resolve(option(
      args,
      ["--manifest"],
      env.OCTO_HARNESS_MANIFEST ?? fileURLToPath(new URL("../../../config/adapters.json", import.meta.url))
    )),
    hostEntrypoint: resolve(option(
      args,
      ["--adapter-host", "--host-entrypoint"],
      env.OCTO_HARNESS_ADAPTER_HOST ?? fileURLToPath(new URL("../../adapter-host/dist/index.js", import.meta.url))
    )),
    ...(selectedAgentWorks.length ? { agentWorks: selectedAgentWorks } : {})
  };
}

/**
 * Agent Work is opt-in: absent a base URL it stays disabled and returns undefined.
 * Once enabled, the device token becomes required (fail fast rather than connect
 * half-configured), and channel-context storage/projection knobs are
 * validated against their allowed enums.
 */
function resolveAgentWorkOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string,
  managed: AgentWorkRuntimeOptions | undefined
): AgentWorkRuntimeOptions | undefined {
  const baseUrl = managed?.baseUrl ?? optionalOption(args, ["--agent-work-url"], env.OCTO_HARNESS_AGENT_WORK_URL);
  if (!baseUrl) return undefined;
  if (!managed?.token) throw new Error("Agent Work Runtime credential is missing from the managed Harness Home");
  const token = managed.token;
  return {
    profile: managed.profile,
    baseUrl,
    token,
    runtimeId: managed?.runtimeId ?? optionalOption(args, ["--agent-work-runtime-id"], env.OCTO_HARNESS_AGENT_WORK_RUNTIME_ID),
    runtimeName: optionalOption(
      args,
      ["--agent-work-runtime-name"],
      env.OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME ?? managed?.runtimeName
    ) ?? "octo-harness-local",
    ...(managed?.adapterConfigurations ? { adapterConfigurations: managed.adapterConfigurations } : {}),
    storePath: resolve(optionalOption(
      args,
      ["--agent-work-db"],
      env.OCTO_HARNESS_AGENT_WORK_DB ?? managed?.storePath
    ) ?? join(home, "agent-work.db")),
    ...optionalNumber(args, ["--agent-work-send-window"], env.OCTO_HARNESS_AGENT_WORK_SEND_WINDOW, "sendWindow"),
    ...optionalNumber(args, ["--agent-work-soft-bytes"], env.OCTO_HARNESS_AGENT_WORK_SOFT_BYTES, "softWatermarkBytes"),
    ...optionalNumber(args, ["--agent-work-hard-bytes"], env.OCTO_HARNESS_AGENT_WORK_HARD_BYTES, "hardWatermarkBytes"),
    ...optionalNumber(
      args,
      ["--agent-work-minimum-free-bytes"],
      env.OCTO_HARNESS_AGENT_WORK_MINIMUM_FREE_BYTES,
      "minimumFreeBytes"
    ),
    ...optionalNumber(
      args,
      ["--agent-work-disk-check-ms"],
      env.OCTO_HARNESS_AGENT_WORK_DISK_CHECK_MS,
      "diskCheckMs"
    ),
    ...optionalNumber(
      args,
      ["--agent-work-reconnect-first-ms"],
      env.OCTO_HARNESS_AGENT_WORK_RECONNECT_FIRST_MS,
      "reconnectFirstMs"
    ),
    ...optionalNumber(
      args,
      ["--agent-work-reconnect-min-ms"],
      env.OCTO_HARNESS_AGENT_WORK_RECONNECT_MIN_MS,
      "reconnectMs"
    ),
    ...optionalNumber(
      args,
      ["--agent-work-reconnect-max-ms"],
      env.OCTO_HARNESS_AGENT_WORK_RECONNECT_MAX_MS,
      "reconnectMaxMs"
    ),
    ...optionalNumber(
      args,
      ["--agent-work-max-concurrent-runs"],
      env.OCTO_HARNESS_AGENT_WORK_MAX_CONCURRENT_RUNS,
      "maxConcurrentRuns"
    )
  };
}

function optionalAgentWorks(runtime: AgentWorkRuntimeOptions | undefined): AgentWorkRuntimeOptions[] {
  return runtime ? [runtime] : [];
}

function optionalNumber(
  args: string[],
  names: string[],
  fallback: string | undefined,
  key: string
): Record<string, number> {
  const raw = optionalOption(args, names, fallback);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${names[0]} must be a positive number`);
  return { [key]: value };
}

/**
 * Serialize resolved options back into argv for the spawned daemon child, so the
 * launcher and the daemon share one resolution pass. Only emit Agent Work flags
 * when it is enabled; optional numeric knobs are omitted when unset.
 */
export function daemonRuntimeArguments(paths: StandardDaemonOptions): string[] {
  const args = [
    ...(paths.homePath ? ["--home", paths.homePath] : []),
    ...(paths.pidPath ? ["--pid-file", paths.pidPath] : []),
    ...(paths.consoleOutput ? ["--console"] : []),
    "--socket", paths.socketPath,
    "--store", paths.storePath,
    "--manifest", paths.manifestPath,
    "--adapter-host", paths.hostEntrypoint
  ];
  const serializedRuntime = paths.agentWorks?.length === 1 ? paths.agentWorks[0] : undefined;
  const commonRuntime = serializedRuntime ?? paths.agentWorks?.[0];
  if (serializedRuntime) {
    args.push(
      "--agent-work-url", serializedRuntime.baseUrl,
      "--agent-work-runtime-name", serializedRuntime.runtimeName,
      "--agent-work-db", serializedRuntime.storePath,
    );
    if (serializedRuntime.runtimeId) args.push("--agent-work-runtime-id", serializedRuntime.runtimeId);
  } else if (commonRuntime) {
    args.push(
      "--agent-work-runtime-name", commonRuntime.runtimeName,
    );
  }
  if (commonRuntime) pushAgentWorkTuningArguments(args, commonRuntime);
  // Managed credentials are reloaded from --home and never serialized to argv.
  return args;
}

function pushAgentWorkTuningArguments(args: string[], runtime: AgentWorkRuntimeOptions): void {
  pushNumberOption(args, "--agent-work-send-window", runtime.sendWindow);
  pushNumberOption(args, "--agent-work-soft-bytes", runtime.softWatermarkBytes);
  pushNumberOption(args, "--agent-work-hard-bytes", runtime.hardWatermarkBytes);
  pushNumberOption(args, "--agent-work-minimum-free-bytes", runtime.minimumFreeBytes);
  pushNumberOption(args, "--agent-work-disk-check-ms", runtime.diskCheckMs);
  pushNumberOption(args, "--agent-work-reconnect-first-ms", runtime.reconnectFirstMs);
  pushNumberOption(args, "--agent-work-reconnect-min-ms", runtime.reconnectMs);
  pushNumberOption(args, "--agent-work-reconnect-max-ms", runtime.reconnectMaxMs);
  pushNumberOption(args, "--agent-work-max-concurrent-runs", runtime.maxConcurrentRuns);
}

function pushNumberOption(args: string[], name: string, value: number | undefined): void {
  if (value !== undefined) args.push(name, String(value));
}

function booleanOption(args: string[], name: string, fallback: boolean): boolean {
  return args.includes(name) || fallback;
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

function optionalOption(
  args: string[],
  names: string[],
  fallback: string | undefined
): string | undefined {
  const value = option(args, names, fallback ?? "").trim();
  return value || undefined;
}

function defaultHarnessHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === "win32" && env.LOCALAPPDATA?.trim()) return join(env.LOCALAPPDATA.trim(), "OctoHarness");
  return join(env.HOME?.trim() || homedir(), ".octo-harness");
}

function defaultSocketPath(home: string): string {
  if (process.platform !== "win32") return join(home, "sockets", "octo-harness-daemon.sock");
  const id = createHash("sha256").update(home.toLowerCase()).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\octo-harness-${id}`;
}
