import {
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
  spawnAcpClient,
  type AcpUpdate
} from "@mininglamp-oss/octo-harness-acp-client";

type JsonRecord = Record<string, unknown>;

export interface AcpAdapterDefinition {
  type: string;
  provider: string;
  command: string;
  args?: readonly string[] | ((request: InvokeRequest) => readonly string[]);
  capabilities?: readonly string[];
  protocolVersion?: string | number;
}

export interface StandardAcpUpdate extends AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  text?: string;
  toolCallId?: string;
  name?: string;
  title?: string;
  rawInput?: unknown;
  input?: unknown;
  rawOutput?: unknown;
  output?: unknown;
  status?: string;
}

export function normalizeAcpUpdate(update: StandardAcpUpdate, provider: string): CanonicalEvent[] {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text = contentText(update.content) ?? update.text;
    if (!text) return [];
    return [{
      type: "message.delta",
      payload: type === "agent_thought_chunk"
        ? {
            text,
            channel: "analysis",
            exposure: "public_reasoning",
            provenance: { provider, nativeEvent: type }
          }
        : { text, channel: "final" }
    }];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    const input = update.rawInput ?? update.input;
    return [{
      type: "tool_call.create",
      payload: {
        id: update.toolCallId,
        name: update.name ?? update.title ?? "provider_tool",
        args: isRecord(input) ? input : input == null ? {} : { value: input }
      }
    }];
  }
  if (type === "tool_call_update") {
    if (!update.toolCallId) return [];
    return [{
      type: "tool_call.update",
      payload: {
        id: update.toolCallId,
        status: update.status ?? "running",
        output: update.rawOutput ?? update.output ?? update.content
      }
    }];
  }
  if (type === "usage" || type === "usage_update") {
    return [{ type: "usage.update", payload: { ...update.usage, model: update.model } }];
  }
  return [];
}

export function createAcpAdapter(
  definition: AcpAdapterDefinition,
  { acpClientFactory = spawnAcpClient, command = definition.command }: {
    acpClientFactory?: typeof spawnAcpClient;
    command?: string;
  } = {}
) {
  return defineAdapter({
    metadata: {
      type: definition.type,
      capabilities: [...(definition.capabilities ?? ["session.serialize", "tool.canonical"])]
    },
    probe: () => probeCommand(command),
    async *invoke(request: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      const args = typeof definition.args === "function" ? definition.args(request) : definition.args ?? ["acp"];
      const autoApprove = request.agentConfig?.autoApprove === true
        || request.agentConfig?.dangerouslyBypassPermissions === true;
      const client = acpClientFactory({
        command,
        args: [...args],
        cwd: request.workdir,
        ...(autoApprove ? { permissionHandler: allowPermission } : {})
      });
      let sessionId: string | undefined;
      let terminal = false;
      let forceCloseTimer: NodeJS.Timeout | undefined;
      const abort = (): void => {
        if (sessionId) client.cancel(sessionId);
        forceCloseTimer ??= setTimeout(() => { void client.close(); }, 250);
        forceCloseTimer.unref?.();
      };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener("abort", abort, { once: true });

      try {
        await client.initialize({ protocolVersion: definition.protocolVersion ?? 1 });
        const requestedSessionId = request.providerSession?.sessionId;
        const sessionMethod = requestedSessionId ? "session/load" : "session/new";
        const sessionParams = requestedSessionId
          ? acpLoadSessionParams(requestedSessionId, { cwd: request.workdir })
          : acpNewSessionParams({ cwd: request.workdir, model: request.agentConfig?.model });
        const sessionRequestId = client.reserveRequestId();
        await observeInput(context, sessionMethod, sessionParams, sessionRequestId, requestedSessionId);
        try {
          const result = await client.request<JsonRecord>(sessionMethod, sessionParams, {
            requestId: sessionRequestId,
            ...(requestedSessionId ? { timeoutMs: 600_000 } : {}),
            onWritten: () => observeWritten(context, sessionMethod, sessionRequestId, requestedSessionId)
          });
          sessionId = requestedSessionId ?? stringField(result, "sessionId");
          if (!sessionId) throw new Error("ACP session/new returned no sessionId");
          observeAcknowledged(context, sessionMethod, sessionRequestId, sessionId);
        } catch (error) {
          observeFailed(context, sessionMethod, sessionRequestId, requestedSessionId, error);
          throw error;
        }

        yield {
          type: "session.update",
          payload: { providerSession: { sessionId, resumable: true, model: request.agentConfig?.model } }
        };
        yield { type: "message.create", payload: { role: "assistant", status: "streaming" } };

        const prompt = request.appendInstructions
          ? `${providerInputText(request)}\n\n${request.appendInstructions}`
          : providerInputText(request);
        const promptParams = acpPromptParams(sessionId, prompt);
        const promptRequestId = client.reserveRequestId();
        await observeInput(context, "session/prompt", promptParams, promptRequestId, sessionId);
        let firstOutput = true;
        let stopReason: string | undefined;
        let finishReason: string | undefined;
        const activeTools = new Set<string>();
        try {
          for await (const update of client.prompt(sessionId, prompt, {
            requestId: promptRequestId,
            params: promptParams,
            onWritten: () => observeWritten(context, "session/prompt", promptRequestId, sessionId)
          })) {
            if (firstOutput) {
              firstOutput = false;
              observeBestEffort(context, {
                event: "provider.output.first",
                rpcMethod: "session/update",
                providerSessionId: sessionId,
                providerRequestId: String(promptRequestId)
              });
            }
            if (update.type === "prompt_result") {
              stopReason = update.stopReason;
              finishReason = update.finishReason;
              continue;
            }
            const standardUpdate = update as StandardAcpUpdate;
            const events = normalizeAcpUpdate(standardUpdate, definition.provider);
            observeProviderOutput(context, events, {
              rpcMethod: "session/update",
              providerSessionId: sessionId,
              providerRequestId: String(promptRequestId),
              native: {
                type: standardUpdate.sessionUpdate ?? standardUpdate.type ?? "session/update",
                provider: definition.provider
              }
            });
            for (const event of events) {
              const id = stringField(event.payload, "id");
              if (event.type === "tool_call.create" && id) activeTools.add(id);
              if (event.type === "tool_call.update" && id && isTerminalToolStatus(event.payload.status)) activeTools.delete(id);
              yield event;
            }
          }
          observeAcknowledged(context, "session/prompt", promptRequestId, sessionId);
        } catch (error) {
          observeFailed(context, "session/prompt", promptRequestId, sessionId, error);
          throw error;
        }

        const cancelled = request.signal?.aborted || isCancelledStopReason(stopReason);
        if (cancelled) {
          for (const id of activeTools) yield { type: "tool_call.update", payload: { id, status: "cancelled" } };
        }
        yield { type: "message.update", payload: { role: "assistant", status: cancelled ? "stopped" : "completed" } };
        terminal = true;
        yield cancelled
          ? { type: "run.stopped", payload: { reason: stopReason ?? String(request.signal?.reason ?? "cancelled"), ...(finishReason ? { finishReason } : {}) } }
          : { type: "run.finished", payload: {} };
      } catch (error) {
        if (!terminal && request.signal?.aborted) {
          terminal = true;
          yield { type: "run.stopped", payload: { reason: String(request.signal.reason ?? "cancelled") } };
        } else {
          throw error;
        }
      } finally {
        request.signal?.removeEventListener("abort", abort);
        if (forceCloseTimer) clearTimeout(forceCloseTimer);
        await client.close();
      }
    }
  });
}

async function observeInput(
  context: AdapterInvocationContext | undefined,
  method: string,
  params: JsonRecord,
  requestId: number,
  sessionId?: string
): Promise<void> {
  await context?.observe({
    event: "provider.input",
    rpcMethod: method,
    providerRequestId: String(requestId),
    ...(sessionId ? { providerSessionId: sessionId } : {}),
    carrier: { kind: "json_params", content: { method, params } }
  });
}

function observeWritten(context: AdapterInvocationContext | undefined, method: string, requestId: number, sessionId?: string): void {
  observeBestEffort(context, {
    event: "provider.dispatch.written",
    rpcMethod: method,
    providerRequestId: String(requestId),
    ...(sessionId ? { providerSessionId: sessionId } : {})
  });
}

function observeAcknowledged(context: AdapterInvocationContext | undefined, method: string, requestId: number, sessionId: string): void {
  observeBestEffort(context, {
    event: "provider.dispatch.acknowledged",
    rpcMethod: method,
    providerRequestId: String(requestId),
    providerSessionId: sessionId
  });
}

function observeFailed(
  context: AdapterInvocationContext | undefined,
  method: string,
  requestId: number,
  sessionId: string | undefined,
  error: unknown
): void {
  observeBestEffort(context, {
    event: "provider.dispatch.failed",
    rpcMethod: method,
    providerRequestId: String(requestId),
    ...(sessionId ? { providerSessionId: sessionId } : {}),
    data: { error: error instanceof Error ? error.message : String(error) }
  });
}

function contentText(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.text === "string") return value.text;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(isRecord)
    .map(item => typeof item.text === "string" ? item.text : "")
    .join("");
  return text || undefined;
}

function isTerminalToolStatus(status: unknown): boolean {
  return typeof status === "string"
    && ["completed", "failed", "error", "cancelled", "canceled", "stopped"].includes(status.toLowerCase());
}

function isCancelledStopReason(reason: unknown): boolean {
  return typeof reason === "string"
    && ["cancelled", "canceled", "interrupted", "aborted"].includes(reason.toLowerCase());
}

function allowPermission(params: JsonRecord): JsonRecord {
  const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  const selected = options.find(option => {
    const label = stringField(option, "kind") ?? stringField(option, "name") ?? "";
    return /allow|approve/i.test(label) && !/always/i.test(label);
  }) ?? options.find(option => {
    const label = stringField(option, "kind") ?? stringField(option, "name") ?? "";
    return /allow|approve/i.test(label);
  });
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId ?? selected.id } }
    : { outcome: { outcome: "cancelled" } };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: JsonRecord, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
