import { canonicalTerminalStatus } from "@mininglamp-oss/octo-harness-protocol";
/**
 * CodeBuddy adapter: wraps the CodeBuddy CLI spoken over ACP (Agent Client
 * Protocol) as JSON-RPC 2.0 on stdio, and normalizes its `session/update`
 * notifications into the harness canonical event stream.
 */
import {
  AcpApprovalBridge,
  AcpTurnNormalizer,
  acpToolTerminalStatus,
  normalizeAcpToolUpdate,
  defineAdapter,
  observeBestEffort,
  observeProviderOutput,
  probeCommand,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  acpLoadSessionParams,
  acpNewSessionParams,
  acpPromptParams,
  spawnAcpClient
} from "@mininglamp-oss/octo-harness-acp-client";
import type { AcpUpdate } from "@mininglamp-oss/octo-harness-acp-client";

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
    const text = isRecord(update.content) && typeof update.content.text === "string" ? update.content.text : update.text;
    if (typeof text !== "string") return [];
    return [{ protocolVersion: 2,
      type: "message.delta",
      payload: type === "agent_thought_chunk"
        ? {
            // agent_thought_chunk is CodeBuddy's presentation-facing ACP reasoning stream.
            text,
            channel: "analysis",
            exposure: "public_reasoning",
            provenance: { provider: "codebuddy", nativeEvent: "agent_thought_chunk" }
          }
        : { text, channel: "final" }
    }];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    if (acpToolTerminalStatus(update.status)) return normalizeAcpToolUpdate(update);
    const value = update.rawInput ?? update.input;
    const args = isRecord(value) ? value : value == null ? {} : { value };
    return [{ protocolVersion: 2,
      type: "tool_call.create",
      payload: { status: "running", id: update.toolCallId, name: update.name ?? update.title ?? "provider_tool", args }
    }];
  }
  if (type === "tool_call_update") {
    return normalizeAcpToolUpdate(update);
  }
  if (type === "usage") return [{ protocolVersion: 2, type: "usage.update", payload: { ...update.usage, model: update.model } }];
  return [];
}

function isTerminalToolStatus(status: unknown): boolean {
  return typeof status === "string" && ["completed", "failed", "error", "cancelled", "canceled", "stopped"].includes(status.toLowerCase());
}

function isCancelledStopReason(reason: unknown): boolean {
  return typeof reason === "string" && ["cancelled", "canceled", "interrupted", "aborted"].includes(reason.toLowerCase());
}

/**
 * Create a CodeBuddy adapter. Each invocation spawns an ACP client, initializes
 * the connection, then either loads the stored provider session or creates a
 * new one. The final message/run terminals are synthesized here because ACP
 * prompt streams end silently rather than with a terminal.
 */
export function createCodeBuddyAdapter({ acpClientFactory = spawnAcpClient, command = "codebuddy" }: { acpClientFactory?: typeof spawnAcpClient; command?: string } = {}) {
  return defineAdapter({
    metadata: { type: "codebuddy", capabilities: ["session.serialize", "tool.canonical"] },
    probe: () => probeCommand(command),
    async *invoke(req: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      if (req.approvalMode !== "full_access") throw new Error("APPROVAL_MODE_UNSUPPORTED: codebuddy approval bridge is not qualified");
      if (req.agentConfig.effort) throw new Error("REASONING_UNSUPPORTED: codebuddy reasoning selection is not qualified");
      const permissions = new AcpApprovalBridge(req);
      async function* execute(): AsyncGenerator<CanonicalEvent> {
      const client = acpClientFactory({
        command, args: ["--acp", "--permission-mode", "bypassPermissions"],
        cwd: req.workdir, signal: req.signal, permissionHandler: params => permissions.requestPermission(params),
        onPermissionResponseWritten: params => permissions.responseWritten(params),
        onPermissionResponseFailed: (params, error) => permissions.responseFailed(params, error)
      });
      permissions.bindTransport(() => client.close());
      try {
        await client.initialize();
        // Reserve the real JSON-RPC id before capture so every observation for
        // this request matches the id subsequently written to the ACP process.
        const requestedSessionId = req.providerSession?.sessionId;
        const sessionMethod = requestedSessionId ? "session/load" : "session/new";
        const sessionParams = requestedSessionId
          ? acpLoadSessionParams(requestedSessionId, { cwd: req.workdir })
          : acpNewSessionParams({ cwd: req.workdir, model: req.agentConfig?.model });
        const sessionRequestId = client.reserveRequestId();
        await context?.observe({
          event: "provider.input",
          rpcMethod: sessionMethod,
          providerRequestId: String(sessionRequestId),
          ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {}),
          carrier: { kind: "json_params", content: { method: sessionMethod, params: sessionParams } }
        });
        let session: { id: string };
        try {
          const requestOptions = {
            requestId: sessionRequestId,
            ...(requestedSessionId ? { timeoutMs: 600_000 } : {}),
            onWritten: () => observeBestEffort(context, {
              event: "provider.dispatch.written",
              rpcMethod: sessionMethod,
              providerRequestId: String(sessionRequestId),
              ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {})
            })
          };
          const sessionResult = await client.request(sessionMethod, sessionParams, requestOptions);
          if (requestedSessionId) {
            session = { id: requestedSessionId };
          } else {
            const sessionId = isRecord(sessionResult) && typeof sessionResult.sessionId === "string"
              ? sessionResult.sessionId
              : undefined;
            if (!sessionId) throw new Error("ACP session/new returned no sessionId");
            session = { id: sessionId };
          }
          observeBestEffort(context, {
            event: "provider.dispatch.acknowledged",
            rpcMethod: sessionMethod,
            providerRequestId: String(sessionRequestId),
            providerSessionId: session.id
          });
        } catch (error) {
          observeBestEffort(context, {
            event: "provider.dispatch.failed",
            rpcMethod: sessionMethod,
            providerRequestId: String(sessionRequestId),
            ...(requestedSessionId ? { providerSessionId: requestedSessionId } : {}),
            data: { error: error instanceof Error ? error.message : String(error) }
          });
          throw error;
        }
        // The AgentSession stores only the provider sessionId; both the
        // new and resume paths converge on the same ACP prompt stream.
        yield { protocolVersion: 2, type: "session.update", payload: { providerSession: { sessionId: session.id, resumable: true, model: req.agentConfig?.model } } };
        // Build once and reuse for capture and dispatch. Reconstructing the
        // carrier separately risks evaluating content that was never sent.
        const prompt = `${providerInputText(req)}\n\n${req.controlInstructions}`;
        const promptParams = acpPromptParams(session.id, prompt);
        const promptRequestId = client.reserveRequestId();
        // The await is the strict-capture gate and occurs before session/prompt
        // is written to the ACP subprocess.
        await context?.observe({
          event: "provider.input",
          rpcMethod: "session/prompt",
          providerSessionId: session.id,
          providerRequestId: String(promptRequestId),
          carrier: {
            kind: "json_params",
            content: { method: "session/prompt", params: promptParams }
          }
        });
        try {
          let firstOutput = true;
          let promptStopReason: string | undefined;
          let promptFinishReason: string | undefined;
          const activeToolIds = new Set<string>();
          const turn = new AcpTurnNormalizer("codebuddy");
          for await (const update of client.prompt(session.id, prompt, {
            requestId: promptRequestId,
            params: promptParams,
            onWritten: () => {
              // ACP's stdin callback establishes local write completion only.
              observeBestEffort(context, {
                event: "provider.dispatch.written",
                rpcMethod: "session/prompt",
                providerSessionId: session.id,
                providerRequestId: String(promptRequestId)
              });
            }
          })) {
            if (firstOutput) {
              firstOutput = false;
              // session/update may precede the final response and is therefore
              // an output milestone, not request acknowledgement.
              observeBestEffort(context, {
                event: "provider.output.first",
                rpcMethod: "session/update",
                providerSessionId: session.id,
                providerRequestId: String(promptRequestId)
              });
            }
            if (update.type === "prompt_result") {
              promptStopReason = update.stopReason;
              promptFinishReason = update.finishReason;
              continue;
            }
            const events = turn.normalize(update.sessionUpdate ?? update.type, normalizeCodeBuddyUpdate(update));
            const nativeType = typeof update.sessionUpdate === "string"
              ? update.sessionUpdate
              : update.type;
            observeProviderOutput(context, events, {
              rpcMethod: "session/update",
              providerSessionId: session.id,
              providerRequestId: String(promptRequestId),
              native: {
                type: nativeType,
                ...(update.model ? { model: update.model } : {})
              }
            });
            for (const event of events) {
              const toolID = typeof event.payload.id === "string" ? event.payload.id : undefined;
              if (event.type === "tool_call.create" && toolID) activeToolIds.add(toolID);
              if (event.type === "tool_call.update" && toolID && isTerminalToolStatus(event.payload.status)) activeToolIds.delete(toolID);
              yield event;
            }
          }
          // AcpClient.prompt completes only after the session/prompt response;
          // this is the protocol acknowledgement boundary.
          observeBestEffort(context, {
            event: "provider.dispatch.acknowledged",
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId)
          });
          const cancelled = isCancelledStopReason(promptStopReason);
          if (cancelled) {
            for (const id of activeToolIds) {
              yield { protocolVersion: 2, type: "tool_call.update", payload: { id, status: canonicalTerminalStatus("cancelled") } };
            }
          }
          for (const event of turn.finish(promptFinishReason ?? promptStopReason, cancelled ? "cancelled" : "completed")) yield event;
          const terminalMessage: CanonicalEvent = { protocolVersion: 2,
            type: "message.update",
            payload: { role: "assistant", status: cancelled ? "stopped" : "completed" }
          };
          observeProviderOutput(context, [terminalMessage], {
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId),
            native: { type: "session/prompt.response" }
          });
          yield terminalMessage;
          yield cancelled
            ? { protocolVersion: 2, type: "run.cancelled", payload: { reason: promptStopReason ?? "cancelled", ...(promptFinishReason ? { finishReason: promptFinishReason } : {}) } }
            : { protocolVersion: 2, type: "run.completed", payload: {} };
        } catch (error) {
          observeBestEffort(context, {
            event: "provider.dispatch.failed",
            rpcMethod: "session/prompt",
            providerSessionId: session.id,
            providerRequestId: String(promptRequestId),
            data: { error: error instanceof Error ? error.message : String(error) }
          });
          throw error;
        }
      } finally { await client.close?.(); }
      }
      try { yield* permissions.stream(execute()); }
      finally { permissions.close("execution_lost"); }
    }
  });
}

/** Narrow an unknown value to a plain object (excluding arrays), used to guard ACP payloads before indexing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const codebuddyAdapter = createCodeBuddyAdapter();
export default codebuddyAdapter;
