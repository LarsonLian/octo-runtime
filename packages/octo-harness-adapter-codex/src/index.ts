import { invocationEnvironment } from "@mininglamp-oss/octo-harness-adapter-sdk";
/**
 * Assembly entry point for the Codex adapter.
 *
 * This file only handles "how to prepare one invocation": selecting the real
 * CODEX_HOME, declaring adapter metadata, and delegating execution to the
 * app-server transport. Per-run developer instructions travel in native thread
 * params, so app-server sees the complete state database and plugin runtime.
 */
import {
  defineAdapter,
  probeCommand,
  type AdapterInvocationContext,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  executionFeatures,
  type InteractionResponse,
  type NativeInteractionResponse
} from "@mininglamp-oss/octo-harness-protocol";
import { parse } from "smol-toml";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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

/** MCP servers that ChatGPT.app provisions to carry computer-use capability, in preference order. */
const COMPUTER_USE_MCP_SERVERS = ["computer-use", "node_repl"] as const;

/** Why a shared CODEX_HOME does not currently expose computer use, or `undefined` when it does. */
export type ComputerUseUnavailableReason =
  "config_missing" | "mcp_server_absent" | "mcp_server_disabled";

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
function parseComputerUseProvisioning(
  codexHome: string,
  configText: string
): ComputerUseProvisioning {
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

  if (servers.length === 0)
    return { available: false, codexHome, servers, reason: "mcp_server_absent" };
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
  return parseComputerUseProvisioning(
    codexHome,
    await readOptional(join(codexHome, "config.toml"))
  );
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
  const runEnv = invocationEnvironment(req, {}, env);
  const realHome = runEnv.CODEX_HOME || join(homedir(), ".codex");
  return {
    command,
    args: [...appServerArgs, ...nativeCapacityOverrides(req)],
    cwd: req.workdir,
    env: { ...runEnv, CODEX_HOME: realHome },
    cleanup: () => undefined
  };
}

/** 宿主已核实的窗口同步给 Codex；历史由原生自动压缩处理，绝不重发已接受的 turn。 */
function nativeCapacityOverrides(request: InvokeRequest): string[] {
  const value = request.runMetadata?.contextCapacity as Record<string, unknown> | undefined;
  if (!value) return [];
  const window = value.contextWindow;
  const reserve = value.outputReserveTokens;
  if (
    value.management !== "provider_native" ||
    typeof window !== "number" ||
    !Number.isSafeInteger(window) ||
    window < 1024 ||
    typeof reserve !== "number" ||
    !Number.isSafeInteger(reserve) ||
    reserve < 0 ||
    reserve >= window
  )
    throw new TypeError("CONTEXT_CAPACITY_UNAVAILABLE");
  return [
    "-c",
    `model_context_window=${window}`,
    "-c",
    `model_auto_compact_token_limit=${window - reserve}`
  ];
}

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

    executionFeatures.INTERACTION_RESPONSE,
    executionFeatures.APPROVAL_ASK,
    executionFeatures.APPROVAL_ASSISTED,
    executionFeatures.APPROVAL_FULL_ACCESS,
    executionFeatures.INPUT_IMAGE
  ];
  if (detectComputerUseProvisioningSync(env).available)
    adapterCapabilities.push(COMPUTER_USE_CAPABILITY);
  const interactionResponders = new Map<string, CodexInteractionResponder>();
  const nativeResponders = new Map<
    string,
    (response: NativeInteractionResponse) => Promise<void>
  >();
  return defineAdapter({
    metadata: {
      protocolSupport: {
        protocol: "codex.app-server",
        modes: ["native", "canonical"],
        nativeMethods: [
          "thread/start",
          "thread/resume",
          "turn/start",
          "turn/interrupt",
          "item/commandExecution/requestApproval",
          "execCommandApproval",
          "item/fileChange/requestApproval",
          "applyPatchApproval",
          "item/tool/requestUserInput",
          "mcpServer/elicitation/request"
        ]
      },
      type: "codex",
      capabilities: ["react"],
      agentSources: ["provisioned"],
      executionFeatures: adapterCapabilities,
      processModel: "subprocess-per-invocation",
      transport: "json-rpc-2.0/stdio"
    },
    probe: () => probeCommand(command),
    async respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void> {
      const responder = nativeResponders.get(invocationId);
      if (!responder) throw new Error("INTERACTION_NOT_ACTIVE");
      await responder(response);
    },
    async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
      const responder = interactionResponders.get(invocationId);
      if (!responder) throw new Error(`no active Codex interaction invocation: ${invocationId}`);
      await responder(response);
    },
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext) {
      if (interactionResponders.has(request.invocationId)) {
        throw new Error(`duplicate active Codex invocation: ${request.invocationId}`);
      }
      // The transport owns subprocess cleanup and observation ordering.
      const spec = buildCodexCommand(request, command, appServerArgs, env);
      let activeResponder: CodexInteractionResponder | undefined;
      const onInteractionResponder = (responder: CodexInteractionResponder | undefined): void => {
        if (responder) {
          activeResponder = responder;
          interactionResponders.set(request.invocationId, responder);
        } else if (
          !activeResponder ||
          interactionResponders.get(request.invocationId) === activeResponder
        ) {
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
          onNativeResponder: (responder) => {
            if (responder) nativeResponders.set(request.invocationId, responder);
            else nativeResponders.delete(request.invocationId);
          },
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
