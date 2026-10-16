import { invocationEnvironment } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { codexMcpConfig } from "./mcp.js";
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
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  executionFeatures,
  type InteractionResponse,
  type NativeInteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
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

/**
 * Convert an Octo Runtime InvokeRequest into a launchable app-server process spec.
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
  const mcp = codexMcpConfig(req, runEnv);
  const realHome = runEnv.CODEX_HOME || join(homedir(), ".codex");
  return {
    command,
    args: [...appServerArgs, ...nativeCapacityOverrides(req)],
    cwd: req.workdir,
    env: { ...runEnv, ...mcp.env, CODEX_HOME: realHome },
    ...(Object.keys(mcp.servers).length ? { mcpServers: mcp.servers } : {}),
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
  const interactionResponders = new Map<string, CodexInteractionResponder>();
  const nativeResponders = new Map<
    string,
    (response: NativeInteractionResponse) => Promise<void>
  >();
  return defineAdapter({
    metadata: {
      mcp: true,
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
