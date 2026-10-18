import {
  initialControlInstructions,
  invocationEnvironment
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  canonicalTerminalStatus,
  hasImageInput,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
/**
 * CodeBuddy adapter: wraps the CodeBuddy CLI spoken over ACP (Agent Client
 * Protocol) as JSON-RPC 2.0 on stdio, and normalizes its `session/update`
 * notifications into the harness canonical event stream.
 */
import type { AcpUpdate } from "@mininglamp-oss/octo-runtime-acp-client";
import {
  acpLoadSessionParams,
  acpNewSessionParams,
  acpPromptParams,
  spawnAcpClient
} from "@mininglamp-oss/octo-runtime-acp-client";
import {
  AcpApprovalBridge,
  AcpTurnNormalizer,
  acpToolTerminalStatus,
  defineAdapter,
  normalizeAcpToolUpdate,
  probeCommand,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";

/** One ACP `session/update` notification; fields are optional because their presence depends on `sessionUpdate`. */
interface CodeBuddyUpdate extends AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  text?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  input?: unknown;
  status?: string;
  output?: unknown;
}

/** Translate one ACP update into canonical events; unrecognized update kinds yield nothing. */
export function normalizeCodeBuddyUpdate(update: CodeBuddyUpdate): CanonicalEvent[] {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text =
      isRecord(update.content) && typeof update.content.text === "string"
        ? update.content.text
        : update.text;
    if (typeof text !== "string") return [];
    return [
      {
        protocolVersion: 2,
        type: "message.delta",
        payload:
          type === "agent_thought_chunk"
            ? {
                // agent_thought_chunk is CodeBuddy's presentation-facing ACP reasoning stream.
                text,
                channel: "analysis",
                exposure: "public_reasoning",
                provenance: { provider: "codebuddy", nativeEvent: "agent_thought_chunk" }
              }
            : { text, channel: "final" }
      }
    ];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    if (acpToolTerminalStatus(update.status)) return normalizeAcpToolUpdate(update);
    const value = update.rawInput ?? update.input;
    const args = isRecord(value) ? value : value == null ? {} : { value };
    return [
      {
        protocolVersion: 2,
        type: "tool_call.create",
        payload: {
          status: "running",
          id: update.toolCallId,
          name: update.name ?? update.title ?? "provider_tool",
          args
        }
      }
    ];
  }
  if (type === "tool_call_update") {
    return normalizeAcpToolUpdate(update);
  }
  if (type === "usage")
    return [
      {
        protocolVersion: 2,
        type: "usage.update",
        payload: { ...update.usage, model: update.model }
      }
    ];
  return [];
}

function isTerminalToolStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    ["completed", "failed", "error", "cancelled", "canceled", "stopped"].includes(
      status.toLowerCase()
    )
  );
}

function isCancelledStopReason(reason: unknown): boolean {
  return (
    typeof reason === "string" &&
    ["cancelled", "canceled", "interrupted", "aborted"].includes(reason.toLowerCase())
  );
}

/**
 * Create a CodeBuddy adapter. Each invocation spawns an ACP client, initializes
 * the connection, then either loads the stored provider session or creates a
 * new one. The final message/run terminals are synthesized here because ACP
 * prompt streams end silently rather than with a terminal.
 */
export function createCodeBuddyAdapter({
  acpClientFactory = spawnAcpClient,
  command = "codebuddy"
}: { acpClientFactory?: typeof spawnAcpClient; command?: string } = {}) {
  const responders = new Map<string, AcpApprovalBridge>();
  return defineAdapter({
    metadata: {
      type: "codebuddy",
      agentSources: ["provisioned"]
    },
    probe: () => probeCommand(command),
    async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
      const bridge = responders.get(invocationId);
      if (!bridge) throw new Error("INTERACTION_NOT_ACTIVE");
      await bridge.respond(response);
    },
    async *invoke(
      req: InvokeRequest,
      context?: AdapterInvocationContext
    ): AsyncGenerator<CanonicalEvent> {
      if (hasImageInput(req))
        throw new Error("UNSUPPORTED_INPUT_MODALITY: codebuddy does not encode image input");
      if (responders.has(req.invocationId)) throw new Error("INVOCATION_ALREADY_ACTIVE");
      const permissions = new AcpApprovalBridge(req);
      responders.set(req.invocationId, permissions);
      async function* execute(): AsyncGenerator<CanonicalEvent> {
        const client = await Promise.resolve(
          acpClientFactory({
            command,
            args: ["--acp", "--permission-mode", codeBuddyPermissionMode(req.approvalMode)],
            env: invocationEnvironment(req),
            cwd: req.workdir,
            signal: req.signal,
            permissionHandler: (params) => permissions.requestPermission(params),
            onPermissionResponseWritten: (params) => permissions.responseWritten(params),
            onPermissionResponseFailed: (params, error) =>
              permissions.responseFailed(params, error),
            ...(context?.streamLimits ? { streamLimits: context.streamLimits } : {})
          })
        );
        permissions.bindTransport(() => client.close());
        try {
          await client.initialize();
          const requestedSessionId = req.providerSession?.sessionId;
          const sessionMethod = requestedSessionId ? "session/load" : "session/new";
          const sessionParams = requestedSessionId
            ? acpLoadSessionParams(requestedSessionId, { cwd: req.workdir })
            : acpNewSessionParams({ cwd: req.workdir, model: req.agentConfig?.model });
          const sessionRequestId = client.reserveRequestId();
          let session: { id: string };

          const requestOptions = {
            requestId: sessionRequestId,
            ...(requestedSessionId ? { timeoutMs: 600_000 } : {})
          };
          const sessionResult = await client.request(sessionMethod, sessionParams, requestOptions);
          if (requestedSessionId) {
            session = { id: requestedSessionId };
          } else {
            const sessionId =
              isRecord(sessionResult) && typeof sessionResult.sessionId === "string"
                ? sessionResult.sessionId
                : undefined;
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            session = { id: sessionId };
          }
          // The AgentSession stores only the provider sessionId; both the
          // new and resume paths converge on the same ACP prompt stream.
          yield {
            protocolVersion: 2,
            type: "session.update",
            payload: {
              providerSession: {
                sessionId: session.id,
                resumable: true,
                model: req.agentConfig?.model
              }
            }
          };
          const prompt = `${providerInputText(req)}\n\n${initialControlInstructions(req)}`;
          const promptParams = acpPromptParams(session.id, prompt);
          const promptRequestId = client.reserveRequestId();

          let promptStopReason: string | undefined;
          let promptFinishReason: string | undefined;
          const activeToolIds = new Set<string>();
          const turn = new AcpTurnNormalizer("codebuddy");
          for await (const update of client.prompt(session.id, prompt, {
            requestId: promptRequestId,
            params: promptParams
          })) {
            if (update.type === "prompt_result") {
              promptStopReason = update.stopReason;
              promptFinishReason = update.finishReason;
              continue;
            }
            const events = turn.normalize(
              update.sessionUpdate ?? update.type,
              normalizeCodeBuddyUpdate(update)
            );
            for (const event of events) {
              const toolID = typeof event.payload.id === "string" ? event.payload.id : undefined;
              if (event.type === "tool_call.create" && toolID) activeToolIds.add(toolID);
              if (
                event.type === "tool_call.update" &&
                toolID &&
                isTerminalToolStatus(event.payload.status)
              )
                activeToolIds.delete(toolID);
              yield event;
            }
          }
          const cancelled = isCancelledStopReason(promptStopReason);
          if (cancelled) {
            for (const id of activeToolIds) {
              yield {
                protocolVersion: 2,
                type: "tool_call.update",
                payload: { id, status: canonicalTerminalStatus("cancelled") }
              };
            }
          }
          for (const event of turn.finish(
            promptFinishReason ?? promptStopReason,
            cancelled ? "cancelled" : "completed"
          ))
            yield event;
          const terminalMessage: CanonicalEvent = {
            protocolVersion: 2,
            type: "message.update",
            payload: { role: "assistant", status: cancelled ? "stopped" : "completed" }
          };
          yield terminalMessage;
          yield cancelled
            ? {
                protocolVersion: 2,
                type: "run.cancelled",
                payload: {
                  reason: promptStopReason ?? "cancelled",
                  ...(promptFinishReason ? { finishReason: promptFinishReason } : {})
                }
              }
            : { protocolVersion: 2, type: "run.completed", payload: {} };
        } finally {
          await client.close?.();
        }
      }
      try {
        yield* permissions.stream(execute());
      } finally {
        permissions.close("execution_lost");
        responders.delete(req.invocationId);
      }
    }
  });
}

export function codeBuddyPermissionMode(mode: InvokeRequest["approvalMode"]): string {
  switch (mode) {
    case "ask":
      return "default";
    case "assisted":
      return "auto";
    case "full_access":
      return "bypassPermissions";
    default:
      throw new Error("APPROVAL_MODE_UNSUPPORTED");
  }
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard ACP payloads before indexing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const codebuddyAdapter = createCodeBuddyAdapter();
export default codebuddyAdapter;
