import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_OBSERVABILITY_CONFIGURATION,
  type ObservabilityConfiguration
} from "@mininglamp-oss/octo-harness-observability";
import type { StartDaemonServerOptions } from "./server.js";
import { loadManagedAgentWork } from "./managed-profile.js";

/**
 * Resolve all daemon runtime paths and options from CLI args and env, defaulting
 * everything under `$OCTO_HARNESS_HOME` (~/.octo-harness). CLI args win over env,
 * env over defaults. Also the single source of truth the CLI uses to locate the
 * daemon socket, so both sides always agree on the path.
 */
export function resolveDaemonRuntimePaths(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): StartDaemonServerOptions {
  const home = resolve(option(args, ["--home"], env.OCTO_HARNESS_HOME ?? defaultHarnessHome(env)));
  const requestedProfile = optionalOption(args, ["--profile"], undefined);
  const managed = loadManagedAgentWork(home, requestedProfile);
  const selectedAgentWork = resolveAgentWorkOptions(args, env, home, managed);
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
    inspectHost: option(args, ["--inspect-host"], env.OCTO_HARNESS_INSPECT_HOST ?? "127.0.0.1"),
    ...optionalPort(args, ["--inspect-port"], env.OCTO_HARNESS_INSPECT_PORT, "inspectPort"),
    logging: resolveLoggingOptions(args, env, home),
    ...(selectedAgentWork ? { agentWork: selectedAgentWork } : {})
  };
}

function resolveLoggingOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string
): ObservabilityConfiguration {
  // `verbose` is a support bundle, not merely a lower severity threshold. Keep
  // its expansion atomic so a diagnostic archive always contains the RPC and
  // provider evidence needed to reconstruct a request end to end.
  const verbose = booleanOption(args, "--verbose", env.OCTO_HARNESS_VERBOSE === "1");
  const explicitLogLevel = optionalOption(args, ["--log-level"], env.OCTO_HARNESS_LOG_LEVEL);
  const explicitCapture = optionalOption(
    args,
    ["--capture-provider-io"],
    env.OCTO_HARNESS_CAPTURE_PROVIDER_IO
  );
  if (verbose && explicitLogLevel && explicitLogLevel !== "debug") {
    throw new Error("--verbose conflicts with --log-level unless it is debug");
  }
  if (verbose && explicitCapture && explicitCapture !== "full") {
    throw new Error("--verbose conflicts with --capture-provider-io unless it is full");
  }
  const logLevel = verbose ? "debug" : enumValue(
    explicitLogLevel ?? DEFAULT_OBSERVABILITY_CONFIGURATION.logLevel,
    ["trace", "debug", "info", "warn", "error"] as const,
    "--log-level"
  );
  const traceRpc = verbose || booleanOption(args, "--trace-rpc", env.OCTO_HARNESS_TRACE_RPC === "1");
  const captureProviderIo = verbose ? "full" : enumValue(
    explicitCapture ?? DEFAULT_OBSERVABILITY_CONFIGURATION.captureProviderIo,
    ["off", "input", "full"] as const,
    "--capture-provider-io"
  );
  const requireProviderCapture = booleanOption(
    args,
    "--require-provider-capture",
    env.OCTO_HARNESS_REQUIRE_PROVIDER_CAPTURE === "1"
  );
  const fileLog = !booleanOption(args, "--no-file-log", env.OCTO_HARNESS_FILE_LOG === "0");
  // Strict capture is a pre-dispatch durability promise. Allowing it without a
  // capture sink would advertise evidence that can never be produced.
  if (requireProviderCapture && captureProviderIo === "off") {
    throw new Error("--require-provider-capture requires --capture-provider-io=input|full");
  }
  if (!fileLog && (verbose || traceRpc || captureProviderIo !== "off" || requireProviderCapture)) {
    // Sensitive traces are deliberately file-only: emitting full provider input
    // to inherited stderr could leak it into terminals, service managers or CI.
    throw new Error("--no-file-log cannot be combined with sensitive capture or strict provider capture");
  }
  return {
    directory: resolve(option(args, ["--log-dir"], env.OCTO_HARNESS_LOG_DIR ?? join(home, "logs"))),
    logLevel,
    fileLog,
    verbose,
    traceRpc,
    captureProviderIo,
    requireProviderCapture,
    retentionDays: positiveIntegerOption(
      args,
      "--log-retention-days",
      env.OCTO_HARNESS_LOG_RETENTION_DAYS,
      DEFAULT_OBSERVABILITY_CONFIGURATION.retentionDays
    ),
    traceRetentionDays: positiveIntegerOption(
      args,
      "--trace-retention-days",
      env.OCTO_HARNESS_TRACE_RETENTION_DAYS,
      DEFAULT_OBSERVABILITY_CONFIGURATION.traceRetentionDays
    ),
    crashRetentionDays: positiveIntegerOption(
      args,
      "--crash-retention-days",
      env.OCTO_HARNESS_CRASH_RETENTION_DAYS,
      DEFAULT_OBSERVABILITY_CONFIGURATION.crashRetentionDays
    ),
    maxFileBytes: positiveIntegerOption(
      args,
      "--log-max-file-bytes",
      env.OCTO_HARNESS_LOG_MAX_FILE_BYTES,
      DEFAULT_OBSERVABILITY_CONFIGURATION.maxFileBytes
    ),
    maxTotalBytes: positiveIntegerOption(
      args,
      "--log-max-total-bytes",
      env.OCTO_HARNESS_LOG_MAX_TOTAL_BYTES,
      DEFAULT_OBSERVABILITY_CONFIGURATION.maxTotalBytes
    )
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
  managed: StartDaemonServerOptions["agentWork"]
): StartDaemonServerOptions["agentWork"] {
  const baseUrl = managed?.baseUrl ?? optionalOption(args, ["--agent-work-url"], env.OCTO_HARNESS_AGENT_WORK_URL);
  if (!baseUrl) return undefined;
  const token = managed?.token;
  if (!token) throw new Error("Agent Work Runtime credential is missing from the managed Harness Home");
  return {
    ...(managed?.profile ? { profile: managed.profile } : {}),
    baseUrl,
    token,
    runtimeId: managed?.runtimeId ?? optionalOption(args, ["--agent-work-runtime-id"], env.OCTO_HARNESS_AGENT_WORK_RUNTIME_ID),
    runtimeName: optionalOption(
      args,
      ["--agent-work-runtime-name"],
      env.OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME ?? managed?.runtimeName
    ) ?? "octo-harness-local",
    fingerprint: managed?.fingerprint ?? optionalOption(
      args,
      ["--agent-work-fingerprint"],
      env.OCTO_HARNESS_AGENT_WORK_FINGERPRINT
    ) ?? `octo-harness:${process.platform}:${process.arch}`,
    storePath: resolve(optionalOption(
      args,
      ["--agent-work-db"],
      env.OCTO_HARNESS_AGENT_WORK_DB ?? managed?.storePath
    ) ?? join(home, "agent-work.db")),
    channelContext: {
      store: enumOption(
        args,
        ["--channel-context-store"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_STORE ?? managed?.channelContext?.store ?? "sqlite",
        ["memory", "sqlite"]
      ),
      projection: enumOption(
        args,
        ["--channel-context-projection"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_PROJECTION ?? managed?.channelContext?.projection ?? "delta",
        ["window", "delta"]
      ),
      providerPersistence: enumOption(
        args,
        ["--channel-context-provider-persistence"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_PROVIDER_PERSISTENCE ?? managed?.channelContext?.providerPersistence ?? "append_only",
        ["ephemeral", "append_only"]
      ),
      storePath: resolve(optionalOption(
        args,
        ["--channel-context-db"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_DB ?? managed?.channelContext?.storePath
      ) ?? join(home, "channel-context.db")),
      ...optionalNumber(args, ["--channel-context-retention-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_RETENTION_MS, "retentionMs"),
      ...optionalNumber(args, ["--channel-context-snapshot-retention-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_SNAPSHOT_RETENTION_MS, "snapshotRetentionMs"),
      ...optionalNumber(args, ["--channel-context-active-snapshot-timeout-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_ACTIVE_SNAPSHOT_TIMEOUT_MS, "activeSnapshotTimeoutMs"),
      ...optionalNumber(args, ["--channel-context-max-scope-messages"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_SCOPE_MESSAGES, "maxMessagesPerScope"),
      ...optionalNumber(args, ["--channel-context-max-projected-messages"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_PROJECTED_MESSAGES, "maxProjectedMessages"),
      ...optionalNumber(args, ["--channel-context-max-projected-bytes"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_PROJECTED_BYTES, "maxProjectedBytes"),
      ...optionalNumber(args, ["--channel-context-sync-timeout-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_SYNC_TIMEOUT_MS, "syncTimeoutMs")
    },
    ...optionalNumber(args, ["--agent-work-send-window"], env.OCTO_HARNESS_AGENT_WORK_SEND_WINDOW, "sendWindow"),
    ...optionalNumber(args, ["--agent-work-soft-bytes"], env.OCTO_HARNESS_AGENT_WORK_SOFT_BYTES, "softWatermarkBytes"),
    ...optionalNumber(args, ["--agent-work-hard-bytes"], env.OCTO_HARNESS_AGENT_WORK_HARD_BYTES, "hardWatermarkBytes"),
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
export function daemonRuntimeArguments(paths: StartDaemonServerOptions): string[] {
  const args = [
    ...(paths.homePath ? ["--home", paths.homePath] : []),
    ...(paths.pidPath ? ["--pid-file", paths.pidPath] : []),
    ...(paths.consoleOutput ? ["--console"] : []),
    "--socket", paths.socketPath,
    "--store", paths.storePath,
    "--manifest", paths.manifestPath,
    "--adapter-host", paths.hostEntrypoint
  ];
  if (paths.inspectHost) args.push("--inspect-host", paths.inspectHost);
  pushNumberOption(args, "--inspect-port", paths.inspectPort);
  if (paths.logging) {
    // Pass the fully resolved policy to the child instead of letting it consult a
    // potentially different environment after the launcher has started.
    args.push(
      "--log-dir", paths.logging.directory,
      "--log-level", paths.logging.logLevel,
      "--log-retention-days", String(paths.logging.retentionDays),
      "--trace-retention-days", String(paths.logging.traceRetentionDays),
      "--crash-retention-days", String(paths.logging.crashRetentionDays),
      "--log-max-file-bytes", String(paths.logging.maxFileBytes),
      "--log-max-total-bytes", String(paths.logging.maxTotalBytes)
    );
    if (!paths.logging.fileLog) args.push("--no-file-log");
    if (paths.logging.verbose) args.push("--verbose");
    else {
      if (paths.logging.traceRpc) args.push("--trace-rpc");
      if (paths.logging.captureProviderIo !== "off") {
        args.push("--capture-provider-io", paths.logging.captureProviderIo);
      }
    }
    if (paths.logging.requireProviderCapture) args.push("--require-provider-capture");
  }
  if (paths.agentWork) {
    args.push(
      "--agent-work-url", paths.agentWork.baseUrl,
      "--agent-work-runtime-name", paths.agentWork.runtimeName,
      "--agent-work-fingerprint", paths.agentWork.fingerprint,
      "--agent-work-db", paths.agentWork.storePath,
      "--channel-context-store", paths.agentWork.channelContext?.store ?? "sqlite",
      "--channel-context-projection", paths.agentWork.channelContext?.projection ?? "delta",
      "--channel-context-provider-persistence", paths.agentWork.channelContext?.providerPersistence ?? "append_only",
      "--channel-context-db", paths.agentWork.channelContext?.storePath ?? resolve("channel-context.db")
    );
    if (paths.agentWork.runtimeId) args.push("--agent-work-runtime-id", paths.agentWork.runtimeId);
    pushNumberOption(args, "--agent-work-send-window", paths.agentWork.sendWindow);
    pushNumberOption(args, "--agent-work-soft-bytes", paths.agentWork.softWatermarkBytes);
    pushNumberOption(args, "--agent-work-hard-bytes", paths.agentWork.hardWatermarkBytes);
    pushNumberOption(args, "--agent-work-reconnect-first-ms", paths.agentWork.reconnectFirstMs);
    pushNumberOption(args, "--agent-work-reconnect-min-ms", paths.agentWork.reconnectMs);
    pushNumberOption(args, "--agent-work-reconnect-max-ms", paths.agentWork.reconnectMaxMs);
    pushNumberOption(args, "--agent-work-max-concurrent-runs", paths.agentWork.maxConcurrentRuns);
    pushNumberOption(args, "--channel-context-retention-ms", paths.agentWork.channelContext?.retentionMs);
    pushNumberOption(args, "--channel-context-snapshot-retention-ms", paths.agentWork.channelContext?.snapshotRetentionMs);
    pushNumberOption(args, "--channel-context-active-snapshot-timeout-ms", paths.agentWork.channelContext?.activeSnapshotTimeoutMs);
    pushNumberOption(args, "--channel-context-max-scope-messages", paths.agentWork.channelContext?.maxMessagesPerScope);
    pushNumberOption(args, "--channel-context-max-projected-messages", paths.agentWork.channelContext?.maxProjectedMessages);
    pushNumberOption(args, "--channel-context-max-projected-bytes", paths.agentWork.channelContext?.maxProjectedBytes);
    pushNumberOption(args, "--channel-context-sync-timeout-ms", paths.agentWork.channelContext?.syncTimeoutMs);
  }
  // Managed credentials are reloaded from --home and never serialized to argv.
  return args;
}

function pushNumberOption(args: string[], name: string, value: number | undefined): void {
  if (value !== undefined) args.push(name, String(value));
}

function optionalPort(
  args: string[],
  names: string[],
  fallback: string | undefined,
  key: string
): Record<string, number> {
  const raw = optionalOption(args, names, fallback);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${names[0]} must be an integer between 1 and 65535`);
  }
  return { [key]: value };
}

function booleanOption(args: string[], name: string, fallback: boolean): boolean {
  return args.includes(name) || fallback;
}

function positiveIntegerOption(
  args: string[],
  name: string,
  environmentValue: string | undefined,
  fallback: number
): number {
  const raw = optionalOption(args, [name], environmentValue);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function enumValue<const TValue extends string>(
  value: string,
  allowed: readonly TValue[],
  name: string
): TValue {
  if (!allowed.includes(value as TValue)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as TValue;
}

function enumOption<const TValue extends string>(
  args: string[],
  names: string[],
  fallback: string,
  allowed: readonly TValue[]
): TValue {
  const value = option(args, names, fallback);
  if (!allowed.includes(value as TValue)) throw new Error(`${names[0]} must be one of: ${allowed.join(", ")}`);
  return value as TValue;
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
