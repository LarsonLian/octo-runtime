/**
 * Assembly entry point for the Codex adapter.
 *
 * This file only handles "how to prepare one invocation": selecting the real
 * CODEX_HOME, declaring adapter metadata, and delegating execution to the
 * app-server transport. Per-run developer instructions travel in native thread
 * params, so app-server sees the complete state database and plugin runtime.
 */
import { defineAdapter, probeCommand, type AdapterInvocationContext, type InvokeRequest } from "@mininglamp-oss/octo-harness-adapter-sdk";
import { executionFeatures, contextItem, runMcpServerHash, type InteractionResponse, type McpServers } from "@mininglamp-oss/octo-harness-protocol";
import { parse, stringify } from "smol-toml";
import { readFileSync, mkdirSync, copyFileSync, writeFileSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCodexAppServerArgs,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerSpawn,
  type CodexInteractionResponder
} from "./app-server.js";

export {
  buildCodexAppServerArgs,
  CodexEventNormalizer,
  CodexAppServerProcessError,
  CodexAppServerRpcError,
  normalizeCodexEvent,
  runCodexAppServerTurn,
  type CodexAppServerCommand,
  type CodexAppServerNotification,
  type CodexAppServerSpawn,
  type CodexInteractionResponder
} from "./app-server.js";

/** Read an optional resource; only ENOENT is ignored, permission and I/O errors must surface to the caller. */
async function readOptional(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/**
 * Symlink resources that exist in the real CODEX_HOME into the temp directory.
 *
 * Only a missing source is tolerated; errors such as EACCES or a target conflict
 * must not be swallowed, otherwise we get a Codex process that looks launchable
 * but actually lacks its auth or session state.
 */
async function linkOptional(
  source: string,
  target: string,
  type: Parameters<typeof symlink>[2]
): Promise<void> {
  try {
    await symlink(source, target, type);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Construct a shadow CODEX_HOME for compatibility tests and callers that need
 * a standalone config overlay. Production app-server invocations intentionally
 * do not use it: current Codex versions keep startup state databases in HOME,
 * and a partial shadow triggers state backfill and lock waits.
 *
 * Design goals:
 * 1. harness instructions affect only this turn and never rewrite the user's
 *    real config.toml;
 * 2. auth, session rollout, skills and rules are still provided by the real HOME;
 * 3. on normal completion, failure or cancellation the caller can always delete
 *    the temp directory via cleanup.
 *
 * This is a config overlay, not filesystem or security isolation: the symlinks
 * are live aliases of the real resources, so Codex writes through these paths
 * land in the real HOME. It is also not equivalent to Aily's per-session state
 * mirror: state SQLite, hooks, the MCP bridge and the skill allowlist are not yet
 * copied; see the README for the exact boundary.
 */
export async function createCodexInvocationHome(
  instructions: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const real = env.CODEX_HOME || join(homedir(), ".codex");
  const shadow = await mkdtemp(join(tmpdir(), "octo-harness-codex-"));

  // Copy the config, then override only the private developer instructions; the real config.toml stays read-only.
  const configText = await readOptional(join(real, "config.toml"));
  const config = configText ? parse(configText) : {};
  config.developer_instructions = instructions;
  await writeFile(join(shadow, "config.toml"), stringify(config), { mode: 0o600 });

  // sessions needs a stable real path so thread/resume can find the previous turn's rollout.
  await mkdir(join(real, "sessions"), { recursive: true });
  await Promise.all([
    linkOptional(join(real, "auth.json"), join(shadow, "auth.json"), "file"),
    linkOptional(join(real, "sessions"), join(shadow, "sessions"), "dir"),
    linkOptional(join(real, "skills"), join(shadow, "skills"), "dir"),
    linkOptional(join(real, "rules"), join(shadow, "rules"), "dir")
  ]);
  return { home: shadow, cleanup: () => rm(shadow, { recursive: true, force: true }) };
}

/** MCP servers that ChatGPT.app provisions to carry computer-use capability, in preference order. */
const COMPUTER_USE_MCP_SERVERS = ["computer-use", "node_repl"] as const;

/** Why a shared CODEX_HOME does not currently expose computer use, or `undefined` when it does. */
export type ComputerUseUnavailableReason =
  | "config_missing"
  | "mcp_server_absent"
  | "mcp_server_disabled";

/** One computer-use MCP server as declared in the shared config.toml. */
export interface ComputerUseMcpServer {
  /** Server key, e.g. `computer-use` or `node_repl`. */
  name: string;
  /** Declared launch command. May be a relative path Codex resolves internally; reported verbatim. */
  command?: string;
  /** Declared working directory for the server, reported verbatim. */
  cwd?: string;
  /** Enabled state; a Codex MCP server is enabled unless `enabled = false` is set explicitly. */
  enabled: boolean;
}

/** Result of inspecting the shared CODEX_HOME for ChatGPT.app's computer-use provisioning. */
export interface ComputerUseProvisioning {
  /** True when at least one computer-use MCP server is declared and enabled. */
  available: boolean;
  /** The CODEX_HOME that was inspected. */
  codexHome: string;
  /** Every computer-use MCP server found in config, whether enabled or not. */
  servers: ComputerUseMcpServer[];
  /** Why provisioning is unavailable; omitted when `available` is true. */
  reason?: ComputerUseUnavailableReason;
}

/**
 * Capability advertised in adapter metadata when the shared CODEX_HOME exposes ChatGPT.app's
 * computer-use MCP provisioning. It is derived from `config.toml` at adapter creation and flows to
 * the Agent Work Runtime via `host.list()` — the channel that actually feeds the Runtime's
 * capability set — as well as to the control-plane `describe()` display, which spreads the same
 * metadata.
 */
export const COMPUTER_USE_CAPABILITY = "tool.computer_use";

/** Pure classification of a config.toml body; empty text means the config is missing or unreadable. */
function parseComputerUseProvisioning(codexHome: string, configText: string): ComputerUseProvisioning {
  if (!configText) return { available: false, codexHome, servers: [], reason: "config_missing" };

  const config = parse(configText) as {
    mcp_servers?: Record<string, { command?: unknown; cwd?: unknown; enabled?: unknown }>;
  };
  const mcpServers = config.mcp_servers ?? {};

  const servers: ComputerUseMcpServer[] = [];
  for (const name of COMPUTER_USE_MCP_SERVERS) {
    const entry = mcpServers[name];
    if (!entry) continue;
    servers.push({
      name,
      ...(typeof entry.command === "string" ? { command: entry.command } : {}),
      ...(typeof entry.cwd === "string" ? { cwd: entry.cwd } : {}),
      // A Codex MCP server is enabled unless disabled explicitly.
      enabled: entry.enabled !== false
    });
  }

  if (servers.length === 0) return { available: false, codexHome, servers, reason: "mcp_server_absent" };
  if (!servers.some((server) => server.enabled)) {
    return { available: false, codexHome, servers, reason: "mcp_server_disabled" };
  }
  return { available: true, codexHome, servers };
}

/** Resolve the CODEX_HOME an invocation would use, matching `buildCodexCommand`. */
function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Detect whether the shared CODEX_HOME carries ChatGPT.app's computer-use capability.
 *
 * Desktop GUI abilities (screen/click/type) are not part of the codex binary and are not cloud
 * calls. The ChatGPT.app acts as a provisioner: it writes local MCP servers — `computer-use`
 * (a `Codex Computer Use.app` helper holding the OS TCC grants) and `node_repl` (`cua_repl`) —
 * into the shared `~/.codex`, and any codex binary reading that home inherits the capability. The
 * Harness codex adapter already reuses the real CODEX_HOME, routes untrusted-tool approvals through
 * its non-interactive response handler and does not strip MCP servers, so no runtime toggle is
 * needed; this helper only reports whether the
 * provisioning is present and enabled, so a caller can surface a clear "install/run ChatGPT.app
 * first" message instead of a silent tool-not-found at turn time.
 *
 * The detection stays at the config level on purpose: the `computer-use` command is a relative
 * path Codex resolves against a provider-internal base directory (observed under
 * `<CODEX_HOME>/computer-use/…`, not `<CODEX_HOME>` directly), so this helper reports the declared
 * `command`/`cwd` verbatim rather than guessing an absolute path and stat-ing it. That the path is
 * relative is exactly why a shadow home breaks computer use and why production must use the real
 * home. `probe` only checks the codex executable, so an available probe does not imply computer use
 * is usable — call this against the same CODEX_HOME `buildCodexCommand` will use.
 */
export async function detectComputerUseProvisioning(
  env: NodeJS.ProcessEnv = process.env
): Promise<ComputerUseProvisioning> {
  const codexHome = resolveCodexHome(env);
  return parseComputerUseProvisioning(codexHome, await readOptional(join(codexHome, "config.toml")));
}

/**
 * Synchronous, best-effort variant used at adapter-creation time to decide capability advertising.
 * Any read or parse failure yields "not provisioned" rather than throwing, so building the adapter
 * (including at module import for the exported singleton) can never fail on a missing/locked config.
 */
export function detectComputerUseProvisioningSync(
  env: NodeJS.ProcessEnv = process.env
): ComputerUseProvisioning {
  const codexHome = resolveCodexHome(env);
  let configText = "";
  try {
    configText = readFileSync(join(codexHome, "config.toml"), "utf8");
  } catch {
    // Missing or unreadable config simply means computer use is not advertised.
  }
  try {
    return parseComputerUseProvisioning(codexHome, configText);
  } catch {
    return { available: false, codexHome, servers: [] };
  }
}

/**
 * Convert an Octo Harness InvokeRequest into a launchable app-server process spec.
 *
 * The user prompt never appears in argv; it is written to stdin later via
 * turn/start. The parent process environment is inherited whole and only
 * The complete real CODEX_HOME is reused. Per-run instructions are sent through
 * thread/start or thread/resume `developerInstructions`, never written to the
 * user's config.toml.
 */
export function buildCodexCommand(
  req: InvokeRequest,
  command = "codex",
  appServerArgs = buildCodexAppServerArgs(),
  env: NodeJS.ProcessEnv = process.env
): CodexAppServerCommand {
  const realHome = env.CODEX_HOME || join(homedir(), ".codex");
  const codexHome = req.skills !== undefined ? prepareScopedCodexHome(req, realHome) : realHome;
  const mcp = codexMcpOverrides(req.mcpServers, env, req);
  return {
    command,
    args: [...appServerArgs, ...mcp.args, ...nativeCapacityOverrides(req)],
    cwd: req.workdir,
    env: { ...env, ...mcp.env, CODEX_HOME: codexHome },
    cleanup: () => undefined
  };
}

/** 宿主已核实的窗口同步给 Codex；历史由原生自动压缩处理，绝不重发已接受的 turn。 */
function nativeCapacityOverrides(request: InvokeRequest): string[] {
  const value = request.runMetadata?.contextCapacity as Record<string, unknown> | undefined;
  if (!value) return [];
  const window = value.contextWindow;
  const reserve = value.outputReserveTokens;
  if (value.management !== "provider_native" || typeof window !== "number" || !Number.isSafeInteger(window) || window < 1024
    || typeof reserve !== "number" || !Number.isSafeInteger(reserve) || reserve < 0 || reserve >= window) throw new TypeError("CONTEXT_CAPACITY_UNAVAILABLE");
  return ["-c", `model_context_window=${window}`, "-c", `model_auto_compact_token_limit=${window - reserve}`];
}

function prepareScopedCodexHome(request: InvokeRequest, realHome: string): string {
  if (!request.providerStateDir) throw new TypeError("SKILL_SCOPE_INVALID");
  const home = join(request.providerStateDir, "codex");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(home).isSymbolicLink()) throw new TypeError("PROVIDER_HOME_INVALID");
  let config: Record<string, unknown> = {};
  try { config = parse(readFileSync(join(realHome, "config.toml"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  for (const key of ["skills", "plugins", "mcp_servers", "developer_instructions", "hooks"]) delete config[key];
  config.features = { ...(typeof config.features === "object" ? config.features : {}), apps: false, plugins: false };
  writeFileSync(join(home, "config.toml"), stringify(config), { mode: 0o600 });
  try { copyFileSync(join(realHome, "auth.json"), join(home, "auth.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return home;
}

/** Build process-local Codex config overrides without placing secret values in argv. */
export function codexMcpOverrides(
  servers: McpServers | undefined,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  invocation?: Pick<InvokeRequest, "approvalMode" | "context" | "runMetadata">
): { args: string[]; env: NodeJS.ProcessEnv } {
  if (!servers || Object.keys(servers).length === 0) return { args: [], env: {} };
  const env: NodeJS.ProcessEnv = {};
  const forwarded = new Map<string, string>();
  const configured: Record<string, Record<string, unknown>> = {};
  const preparedTask = isPreparedFullAccessTask(invocation) && isFrozenRunMcp(invocation, servers, "octo_task");
  const preparedTeam = preparedTask && isPreparedTaskTeam(invocation, servers);

  Object.entries(servers).forEach(([name, server], serverIndex) => {
    const entry: Record<string, unknown> = {};
    if (server.type === "stdio") {
      entry.command = server.command;
      if (server.args) entry.args = server.args;
      if (server.cwd) entry.cwd = server.cwd;
      if (server.env) {
        if (server.env.PLUGIN_ROOT !== undefined && server.env.PLUGIN_DATA !== undefined) {
          entry.env = server.env;
        } else {
          for (const [key, value] of Object.entries(server.env)) {
            const prior = forwarded.get(key);
            if (prior !== undefined && prior !== value) {
              throw new Error(`dynamic MCP stdio environment variable ${key} has conflicting values`);
            }
            forwarded.set(key, value);
            env[key] = value;
          }
          entry.env_vars = Object.keys(server.env);
        }
      }
    } else {
      entry.url = server.url;
      const headerVariables: Record<string, string> = {};
      Object.entries(server.headers ?? {}).forEach(([header, value], headerIndex) => {
        const variable = `OCTO_HARNESS_MCP_${serverIndex}_HEADER_${headerIndex}`;
        env[variable] = value;
        headerVariables[header] = variable;
      });
      if (Object.keys(headerVariables).length > 0) entry.env_http_headers = headerVariables;
    }
    if (server.required !== undefined) entry.required = server.required;
    if (server.startupTimeoutMs !== undefined) entry.startup_timeout_sec = server.startupTimeoutMs / 1000;
    if (server.toolTimeoutMs !== undefined) entry.tool_timeout_sec = server.toolTimeoutMs / 1000;
    const trustedTools = name === "octo_task" && preparedTask ? TASK_MCP_TOOLS
      : name === "octo_team" && preparedTeam ? TEAM_MCP_TOOLS : undefined;
    if (server.type === "streamable_http" && trustedTools) {
      // This reserved server is materialized by Worker, then checked by the
      // Runtime's Task bootstrap. Unknown tools still require native approval.
      entry.default_tools_approval_mode = "prompt";
      entry.tools = Object.fromEntries(trustedTools.map(tool => [tool, { approval_mode: "approve" }]));
    }
    configured[name] = entry;
  });

  // Do not copy inherited values into the returned overlay. buildCodexCommand
  // merges this object on top of inheritedEnv exactly once.
  void inheritedEnv;
  return { args: ["-c", `mcp_servers=${tomlValue(configured)}`], env };
}

const TASK_MCP_TOOLS = [
  "task_get_materials", "task_authorize_material_snapshot", "task_read_attachment", "task_prepare_output", "task_commit_output",
  "task_fail_output", "task_apply_action", "task_create_child"
] as const;
const TEAM_MCP_TOOLS = ["delegate_handoff"] as const;

function isFrozenRunMcp(invocation: Pick<InvokeRequest, "runMetadata"> | undefined, servers: McpServers, name: string): boolean {
  const server = servers[name];
  if (server?.type !== "streamable_http" || server.required !== true) return false;
  const header = server.headers;
  if (!header || !/^Bearer \S+$/.test(header.Authorization ?? "") || !header["X-Space-ID"]
    || header["X-Namespace"] !== invocation?.runMetadata?.namespace) return false;
  const url = new URL(server.url);
  if (url.username || url.password || url.search || url.hash) return false;
  return taskRecord(invocation?.runMetadata?.frozenMcpServers)?.[name] === runMcpServerHash(server);
}

function isPreparedFullAccessTask(invocation: Pick<InvokeRequest, "approvalMode" | "context" | "runMetadata"> | undefined): boolean {
  if (!invocation || invocation.approvalMode !== "full_access"
    || contextItem(invocation.context, "octo.security", "approval_policy")?.payload.mode !== "full_access") return false;
  const materials = contextItem(invocation.context, "octo.content", "references")?.payload.entries;
  const entries = Array.isArray(materials) ? materials : [];
  const snapshots = invocation.runMetadata?.taskMaterials;
  if (!Array.isArray(entries) || entries.length !== 1 || !Array.isArray(snapshots) || snapshots.length !== 1) return false;
  const resource = taskRecord(entries[0]);
  const locator = taskRecord(resource?.locator);
  const params = taskRecord(resource?.params);
  const snapshot = taskRecord(snapshots[0]);
  return resource?.resolver === "mcp" && locator?.server_ref === "octo_task" && locator.tool === "task_get_materials"
    && typeof params?.task_id === "string" && params.task_id.length > 0
    && typeof resource.resource_ref === "string" && resource.resource_ref.length > 0
    && snapshot?.task_id === params.task_id && snapshot.resource_ref === resource.resource_ref
    && Number.isSafeInteger(snapshot.task_version) && Number(snapshot.task_version) > 0
    && Number.isSafeInteger(snapshot.handler_epoch) && Number(snapshot.handler_epoch) > 0
    && (params.handler_epoch === undefined || snapshot.handler_epoch === params.handler_epoch)
    && (params.expected_version === undefined || snapshot.task_version === params.expected_version)
    && typeof snapshot.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(snapshot.digest);
}

function isPreparedTaskTeam(
  invocation: Pick<InvokeRequest, "approvalMode" | "context" | "runMetadata"> | undefined,
  servers: McpServers
): boolean {
  const metadata = invocation?.runMetadata;
  const input = taskRecord(metadata?.input);
  const snapshots = metadata?.taskMaterials;
  if (!Array.isArray(snapshots) || input?.task_id !== taskRecord(snapshots[0])?.task_id
    || typeof input?.conversation_id !== "string" || !input.conversation_id) return false;
  if (metadata?.triggerKind === "coordination.node") {
    const coordination = taskRecord(input?.coordination);
    if (typeof coordination?.team_session_id !== "string" || !coordination.team_session_id
      || typeof coordination.operation_key !== "string" || !coordination.operation_key) return false;
  } else if (metadata?.triggerKind === "coordination.delegate_handoff" || metadata?.triggerKind === "coordination.mailbox") {
    const coordination = taskRecord(input?.coordination);
    if (typeof coordination?.team_session_id !== "string" || !coordination.team_session_id
      || typeof coordination.delegation_id !== "string" || !coordination.delegation_id) return false;
  } else return false;

  // Separate cloud endpoints are trusted only when they match the frozen Run plan.
  const team = servers.octo_team;
  const task = servers.octo_task;
  if (team?.type !== "streamable_http" || task?.type !== "streamable_http"
    || !isFrozenRunMcp(invocation, servers, "octo_team")) return false;
  const headers = Object.entries(task.headers ?? {});
  return headers.length === Object.keys(team.headers ?? {}).length
    && headers.every(([name, value]) => team.headers?.[name] === value);
}

function taskRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function tomlValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${tomlValue(item)}`).join(",")}}`;
  }
  throw new TypeError("unsupported Codex MCP config value");
}

/**
 * Create the Codex adapter.
 *
 * command/appServerArgs/spawnFn are all injectable, mainly to test the real
 * stdin/stdout JSON-RPC without connecting to a real Codex service in tests. The
 * production defaults always run `codex app-server --listen stdio://`.
 * Provider observation is forwarded to the transport unchanged because only
 * the app-server layer knows the final JSON-RPC params and write/response
 * boundaries.
 *
 * `tool.computer_use` is advertised only when the CODEX_HOME this adapter will
 * use already carries ChatGPT.app's computer-use MCP provisioning. Detection runs
 * once here (at creation/registration), which is the same cadence at which
 * `host.list()` snapshots capabilities for the Agent Work Runtime; `env` is
 * injectable so tests can pin the inspected home.
 */
export function createCodexAdapter({
  command = "codex",
  appServerArgs = buildCodexAppServerArgs(),
  spawnFn,
  env = process.env
}: {
  command?: string;
  appServerArgs?: string[];
  spawnFn?: CodexAppServerSpawn;
  env?: NodeJS.ProcessEnv;
} = {}) {
  // Thread serialization and same-turn fresh fallback are end-to-end supported.
  const adapterCapabilities = [
    "session.serialize",
    "session.resume_recovery",
    "activity.turn-progress",
    executionFeatures.MCP_DYNAMIC,
    executionFeatures.INTERACTION_RESPONSE,
    executionFeatures.APPROVAL_ASK,
    executionFeatures.APPROVAL_ASSISTED,
    executionFeatures.APPROVAL_FULL_ACCESS,
    executionFeatures.INPUT_IMAGE
    , "context.capabilities"
  ];
  if (detectComputerUseProvisioningSync(env).available) adapterCapabilities.push(COMPUTER_USE_CAPABILITY);
  const interactionResponders = new Map<string, CodexInteractionResponder>();
  return defineAdapter({
    metadata: {
      type: "codex",
      capabilities: ["react"],
      agentSources: ["provisioned"],
      executionFeatures: adapterCapabilities,
      processModel: "subprocess-per-invocation",
      transport: "json-rpc-2.0/stdio"
    },
    probe: () => probeCommand(command),
    async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
      const responder = interactionResponders.get(invocationId);
      if (!responder) throw new Error(`no active Codex interaction invocation: ${invocationId}`);
      await responder(response);
    },
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext) {
      if (interactionResponders.has(request.invocationId)) {
        throw new Error(`duplicate active Codex invocation: ${request.invocationId}`);
      }
      // The transport owns cleanup as well as observation ordering, so the
      // shadow home cannot be deleted while its final RPC is still in flight.
      const spec = buildCodexCommand(request, command, appServerArgs, env);
      let activeResponder: CodexInteractionResponder | undefined;
      const onInteractionResponder = (responder: CodexInteractionResponder | undefined): void => {
        if (responder) {
          activeResponder = responder;
          interactionResponders.set(request.invocationId, responder);
        } else if (!activeResponder || interactionResponders.get(request.invocationId) === activeResponder) {
          interactionResponders.delete(request.invocationId);
          activeResponder = undefined;
        }
      };
      try {
        yield* runCodexAppServerTurn({
          request,
          spec,
          context,
          onInteractionResponder,
          ...(spawnFn ? { spawnFn } : {})
        });
      } finally {
        onInteractionResponder(undefined);
      }
    }
  });
}

export const codexAdapter = createCodexAdapter();
export default codexAdapter;
