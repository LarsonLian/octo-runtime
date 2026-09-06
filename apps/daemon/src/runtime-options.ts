import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StartDaemonServerOptions } from "./server.js";

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
  const home = resolve(env.OCTO_HARNESS_HOME ?? join(homedir(), ".octo-harness"));
  return {
    socketPath: resolve(option(
      args,
      ["--socket"],
      env.OCTO_HARNESS_SOCKET ?? join(home, "sockets", "octo-harness-daemon.sock")
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
    agentWork: resolveAgentWorkOptions(args, env, home)
  };
}

/**
 * Agent Work is opt-in: absent a base URL it stays disabled and returns undefined.
 * Once enabled, the runtime token/tenant/subject become required (fail fast rather
 * than connect half-configured), and channel-context storage/projection knobs are
 * validated against their allowed enums.
 */
function resolveAgentWorkOptions(
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string
): StartDaemonServerOptions["agentWork"] {
  const baseUrl = optionalOption(args, ["--agent-work-url"], env.OCTO_HARNESS_AGENT_WORK_URL);
  if (!baseUrl) return undefined;
  const token = requiredEnv(env, "OCTO_HARNESS_AGENT_WORK_RUNTIME_TOKEN");
  const tenantId = requiredOption(
    args,
    ["--agent-work-tenant-id"],
    env.OCTO_HARNESS_AGENT_WORK_TENANT_ID,
    "OCTO_HARNESS_AGENT_WORK_TENANT_ID"
  );
  const subjectId = requiredOption(
    args,
    ["--agent-work-subject-id"],
    env.OCTO_HARNESS_AGENT_WORK_SUBJECT_ID,
    "OCTO_HARNESS_AGENT_WORK_SUBJECT_ID"
  );
  return {
    baseUrl,
    token,
    tenantId,
    subjectId,
    runtimeId: optionalOption(args, ["--agent-work-runtime-id"], env.OCTO_HARNESS_AGENT_WORK_RUNTIME_ID),
    runtimeName: optionalOption(
      args,
      ["--agent-work-runtime-name"],
      env.OCTO_HARNESS_AGENT_WORK_RUNTIME_NAME
    ) ?? "octo-harness-local",
    fingerprint: optionalOption(
      args,
      ["--agent-work-fingerprint"],
      env.OCTO_HARNESS_AGENT_WORK_FINGERPRINT
    ) ?? `octo-harness:${process.platform}:${process.arch}`,
    storePath: resolve(optionalOption(
      args,
      ["--agent-work-db"],
      env.OCTO_HARNESS_AGENT_WORK_DB
    ) ?? join(home, "agent-work.db")),
    channelContext: {
      store: enumOption(
        args,
        ["--channel-context-store"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_STORE ?? "memory",
        ["memory", "sqlite"]
      ),
      projection: enumOption(
        args,
        ["--channel-context-projection"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_PROJECTION ?? "window",
        ["window", "delta"]
      ),
      providerPersistence: enumOption(
        args,
        ["--channel-context-provider-persistence"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_PROVIDER_PERSISTENCE ?? "ephemeral",
        ["ephemeral", "append_only"]
      ),
      storePath: resolve(optionalOption(
        args,
        ["--channel-context-db"],
        env.OCTO_HARNESS_CHANNEL_CONTEXT_DB
      ) ?? join(home, "channel-context.db")),
      ...optionalNumber(args, ["--channel-context-retention-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_RETENTION_MS, "retentionMs"),
      ...optionalNumber(args, ["--channel-context-max-scope-messages"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_SCOPE_MESSAGES, "maxMessagesPerScope"),
      ...optionalNumber(args, ["--channel-context-max-projected-messages"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_PROJECTED_MESSAGES, "maxProjectedMessages"),
      ...optionalNumber(args, ["--channel-context-max-projected-bytes"], env.OCTO_HARNESS_CHANNEL_CONTEXT_MAX_PROJECTED_BYTES, "maxProjectedBytes"),
      ...optionalNumber(args, ["--channel-context-sync-timeout-ms"], env.OCTO_HARNESS_CHANNEL_CONTEXT_SYNC_TIMEOUT_MS, "syncTimeoutMs")
    },
    ...optionalNumber(args, ["--agent-work-send-window"], env.OCTO_HARNESS_AGENT_WORK_SEND_WINDOW, "sendWindow"),
    ...optionalNumber(args, ["--agent-work-soft-bytes"], env.OCTO_HARNESS_AGENT_WORK_SOFT_BYTES, "softWatermarkBytes"),
    ...optionalNumber(args, ["--agent-work-hard-bytes"], env.OCTO_HARNESS_AGENT_WORK_HARD_BYTES, "hardWatermarkBytes")
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

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when OCTO_HARNESS_AGENT_WORK_URL is set`);
  return value;
}

/**
 * Serialize resolved options back into argv for the spawned daemon child, so the
 * launcher and the daemon share one resolution pass. Only emit Agent Work flags
 * when it is enabled; optional numeric knobs are omitted when unset.
 */
export function daemonRuntimeArguments(paths: StartDaemonServerOptions): string[] {
  const args = [
    "--socket", paths.socketPath,
    "--store", paths.storePath,
    "--manifest", paths.manifestPath,
    "--adapter-host", paths.hostEntrypoint
  ];
  if (paths.agentWork) {
    args.push(
      "--agent-work-url", paths.agentWork.baseUrl,
      "--agent-work-tenant-id", paths.agentWork.tenantId,
      "--agent-work-subject-id", paths.agentWork.subjectId,
      "--agent-work-runtime-name", paths.agentWork.runtimeName,
      "--agent-work-fingerprint", paths.agentWork.fingerprint,
      "--agent-work-db", paths.agentWork.storePath,
      "--channel-context-store", paths.agentWork.channelContext?.store ?? "memory",
      "--channel-context-projection", paths.agentWork.channelContext?.projection ?? "window",
      "--channel-context-provider-persistence", paths.agentWork.channelContext?.providerPersistence ?? "ephemeral",
      "--channel-context-db", paths.agentWork.channelContext?.storePath ?? resolve("channel-context.db")
    );
    if (paths.agentWork.runtimeId) args.push("--agent-work-runtime-id", paths.agentWork.runtimeId);
    pushNumberOption(args, "--agent-work-send-window", paths.agentWork.sendWindow);
    pushNumberOption(args, "--agent-work-soft-bytes", paths.agentWork.softWatermarkBytes);
    pushNumberOption(args, "--agent-work-hard-bytes", paths.agentWork.hardWatermarkBytes);
    pushNumberOption(args, "--channel-context-retention-ms", paths.agentWork.channelContext?.retentionMs);
    pushNumberOption(args, "--channel-context-max-scope-messages", paths.agentWork.channelContext?.maxMessagesPerScope);
    pushNumberOption(args, "--channel-context-max-projected-messages", paths.agentWork.channelContext?.maxProjectedMessages);
    pushNumberOption(args, "--channel-context-max-projected-bytes", paths.agentWork.channelContext?.maxProjectedBytes);
    pushNumberOption(args, "--channel-context-sync-timeout-ms", paths.agentWork.channelContext?.syncTimeoutMs);
  }
  return args;
}

function pushNumberOption(args: string[], name: string, value: number | undefined): void {
  if (value !== undefined) args.push(name, String(value));
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

function requiredOption(
  args: string[],
  names: string[],
  fallback: string | undefined,
  environmentName: string
): string {
  const value = optionalOption(args, names, fallback);
  if (!value) {
    throw new Error(`${names[0]} or ${environmentName} is required when Agent Work is enabled`);
  }
  return value;
}
