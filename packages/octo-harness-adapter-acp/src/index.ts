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

const MAX_STEP_PUBLIC_TEXT_CHARS = 1_000;

/**
 * ACP standardizes the stream envelope but does not require providers to emit
 * public thought chunks or model-round boundaries. Reconstruct conservative
 * round boundaries from tool lifecycles and retain only already-public answer
 * text as the card fallback when a provider exposes no reasoning.
 */
class AcpTurnNormalizer {
  readonly #provider: string;
  readonly #activeTools = new Set<string>();
  #stepNumber = 0;
  #stepId?: string;
  #stepHasTool = false;
  #stepPublicText = "";
  #toolsCompleted = false;

  constructor(provider: string) {
    this.#provider = provider;
  }

  normalize(update: StandardAcpUpdate): CanonicalEvent[] {
    const nativeType = update.sessionUpdate ?? update.type;
    const normalized = normalizeAcpUpdate(update, this.#provider);
    const semantic = normalized.some(event => event.type.startsWith("message.") || event.type.startsWith("tool_call."));
    if (!semantic) return normalized;

    const startsModelOutput = nativeType === "agent_message_chunk"
      || nativeType === "agent_thought_chunk"
      || nativeType === "tool_call";
    const events: CanonicalEvent[] = [];
    if (startsModelOutput && this.#toolsCompleted) events.push(...this.#finishStep("tool-calls", "completed"));
    events.push(...this.#ensureStep());

    const stepId = this.#stepId;
    for (const event of normalized) {
      if (event.type === "message.delta") {
        events.push({
          ...event,
          payload: {
            ...event.payload,
            ...(stepId ? { stepId } : {}),
            ...(stepId && event.payload.channel === "analysis" ? { messageId: `${stepId}:reasoning` } : {})
          }
        });
        if (event.payload.channel !== "analysis") this.#appendPublicText(event.payload.text);
        continue;
      }
      const toolId = stringField(event.payload, "id");
      if (event.type === "tool_call.create" && toolId) {
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        this.#activeTools.add(toolId);
        this.#stepHasTool = true;
        this.#toolsCompleted = false;
        continue;
      }
      if (event.type === "tool_call.update" && toolId && isTerminalToolStatus(event.payload.status)) {
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        this.#activeTools.delete(toolId);
        if (this.#stepHasTool && this.#activeTools.size === 0) this.#toolsCompleted = true;
        continue;
      }
      if (event.type === "tool_call.update") {
        events.push({ ...event, payload: { ...event.payload, ...(stepId ? { stepId } : {}) } });
        continue;
      }
      events.push(event);
    }
    return events;
  }

  finish(finishReason: string | undefined, status: string): CanonicalEvent[] {
    const reason = this.#stepHasTool && this.#stepPublicText.length === 0
      ? "tool-calls"
      : finishReason ?? "end_turn";
    return this.#finishStep(reason, status);
  }

  #ensureStep(): CanonicalEvent[] {
    if (this.#stepId) return [];
    this.#stepId = `${this.#provider}:step:${++this.#stepNumber}`;
    return [{ type: "model_step.started", payload: { stepId: this.#stepId } }];
  }

  #finishStep(finishReason: string, status: string): CanonicalEvent[] {
    if (!this.#stepId) return [];
    const event: CanonicalEvent = {
      type: "model_step.finished",
      payload: {
        stepId: this.#stepId,
        status,
        finishReason,
        ...(this.#stepPublicText ? { publicText: this.#stepPublicText } : {})
      }
    };
    this.#stepId = undefined;
    this.#stepHasTool = false;
    this.#stepPublicText = "";
    this.#toolsCompleted = false;
    return [event];
  }

  #appendPublicText(value: unknown): void {
    if (typeof value !== "string" || !value) return;
    const remaining = MAX_STEP_PUBLIC_TEXT_CHARS - Array.from(this.#stepPublicText).length;
    if (remaining <= 0) return;
    this.#stepPublicText += Array.from(value).slice(0, remaining).join("");
  }
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
        let providerModel: string | undefined;
        const sessionMethod = requestedSessionId ? "session/load" : "session/new";
        const sessionParams = requestedSessionId
          ? acpLoadSessionParams(requestedSessionId, { cwd: request.workdir })
          : acpNewSessionParams({ cwd: request.workdir });
        const sessionRequestId = client.reserveRequestId();
        await observeInput(context, sessionMethod, sessionParams, sessionRequestId, requestedSessionId);
        try {
          const result = await client.request<JsonRecord>(sessionMethod, sessionParams, {
            requestId: sessionRequestId,
            ...(requestedSessionId ? { timeoutMs: 600_000 } : {}),
            onWritten: () => observeWritten(context, sessionMethod, sessionRequestId, requestedSessionId)
          });
          sessionId = requestedSessionId ?? stringField(result, "sessionId");
          providerModel = stringField(result, "model");
          if (!sessionId) throw new Error("ACP session/new returned no sessionId");
          observeAcknowledged(context, sessionMethod, sessionRequestId, sessionId);
        } catch (error) {
          observeFailed(context, sessionMethod, sessionRequestId, requestedSessionId, error);
          throw error;
        }

        yield {
          type: "session.update",
          payload: {
            providerSession: {
              sessionId,
              resumable: true,
              ...(providerModel ? { model: providerModel } : {})
            }
          }
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
        let promptResultPublicText: string | undefined;
        let producedFinalOutput = false;
        const activeTools = new Set<string>();
        const turn = new AcpTurnNormalizer(definition.provider);
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
              promptResultPublicText = promptResultText(update);
              continue;
            }
            const standardUpdate = update as StandardAcpUpdate;
            const events = turn.normalize(standardUpdate);
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
              if (event.type === "message.delta"
                && event.payload.channel !== "analysis"
                && typeof event.payload.text === "string"
                && event.payload.text.length > 0) {
                producedFinalOutput = true;
              }
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
        if (!cancelled && !producedFinalOutput && promptResultPublicText) {
          const fallbackEvents = turn.normalize({
            type: "prompt_result",
            sessionUpdate: "agent_message_chunk",
            content: { text: promptResultPublicText }
          });
          for (const event of fallbackEvents) yield event;
          producedFinalOutput = true;
        }
        if (cancelled) {
          for (const id of activeTools) yield { type: "tool_call.update", payload: { id, status: "cancelled" } };
        }
        if (!cancelled && !producedFinalOutput) {
          for (const event of turn.finish("no-final-output", "failed")) yield event;
          yield { type: "message.update", payload: { role: "assistant", status: "failed" } };
          terminal = true;
          yield {
            type: "run.error",
            payload: {
              code: "ACP_NO_FINAL_OUTPUT",
              message: `${definition.provider} completed without assistant output`,
              adapterType: definition.type
            }
          };
          return;
        }
        for (const event of turn.finish(stopReason ?? finishReason, cancelled ? "stopped" : "completed")) yield event;
        yield { type: "message.update", payload: { role: "assistant", status: cancelled ? "stopped" : "completed" } };
        terminal = true;
        yield cancelled
          ? { type: "run.stopped", payload: { reason: stopReason ?? String(request.signal?.reason ?? "cancelled"), ...(finishReason ? { finishReason } : {}) } }
          : { type: "run.finished", payload: {} };
      } catch (error) {
        if (!terminal && request.signal?.aborted) {
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

function promptResultText(update: StandardAcpUpdate): string | undefined {
  for (const value of [update.text, update.content, update.output, update.response, update.message]) {
    if (typeof value === "string" && value) return value;
    const text = contentText(value);
    if (text) return text;
  }
  return undefined;
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
