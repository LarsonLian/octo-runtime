import {
  acpLoadSessionParams,
  acpNewSessionParams,
  acpPromptParams,
  spawnAcpClient,
  type AcpUpdate
} from "@mininglamp-oss/octo-runtime-acp-client";
import {
  initialControlInstructions,
  actmodeEvidence,
  AcpApprovalBridge,
  AcpTurnNormalizer,
  acpToolTerminalStatus,
  defineAdapter,
  invocationEnvironment,
  invocationMcpServers,
  assertMcpOptions,
  normalizeAcpToolUpdate,
  probeCommand,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  canonicalTerminalStatus,
  contextActmode,
  providerInputParts,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";

type JsonRecord = Record<string, unknown>;

export interface AcpAdapterDefinition {
  type: string;
  provider: string;
  command: string;
  args?: readonly string[] | ((request: InvokeRequest) => readonly string[]);
  env?: (request: InvokeRequest) => NodeJS.ProcessEnv;
  protocolVersion?: string | number;
  emptyLoadResultMeansMissing?: boolean;
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

export interface AcpModelSelectionRequest {
  method: "session/set_config_option" | "session/set_model";
  params: JsonRecord;
}

/** 只使用 Provider 发布的模式 ID；不从产品名称、审批档位或正文猜测。 */
export function acpActmodeSelectionRequest(
  session: JsonRecord,
  sessionId: string,
  requested: "default" | "plan"
): {
  method: "session/set_config_option" | "session/set_mode";
  params: JsonRecord;
  effective: "default" | "plan";
  nativeMode: string;
  unchanged: boolean;
} {
  const option = arrayField(session, "configOptions")
    .map(recordValue)
    .find(
      (value) => stringField(value, "category") === "mode" || stringField(value, "id") === "mode"
    );
  const modes = recordValue(session.modes);
  const available = option
    ? arrayField(option, "options")
        .flatMap((value) => {
          const entry = recordValue(value);
          return Array.isArray(entry.options) ? entry.options.map(recordValue) : [entry];
        })
        .map((value) => stringField(value, "value"))
    : arrayField(modes, "availableModes").map((value) => stringField(recordValue(value), "id"));
  const ordinary = available.includes("default")
    ? "default"
    : available.includes("build")
      ? "build"
      : undefined;
  const nativeMode = requested === "plan" && available.includes("plan") ? "plan" : ordinary;
  if (!nativeMode) throw new Error("ACTMODE_UNSUPPORTED: ACP did not advertise an applicable mode");
  return {
    method: option ? "session/set_config_option" : "session/set_mode",
    params: option
      ? { sessionId, configId: stringField(option, "id"), value: nativeMode }
      : { sessionId, modeId: nativeMode },
    nativeMode,
    effective: nativeMode === "plan" ? "plan" : "default",
    unchanged:
      (option ? stringField(option, "currentValue") : stringField(modes, "currentModeId")) ===
      nativeMode
  };
}

/** Resolve the model-selection RPC advertised by an ACP session response. */
export function acpModelSelectionRequest(
  session: JsonRecord,
  sessionId: string,
  requestedModel: string
): AcpModelSelectionRequest | undefined {
  const modelOption = arrayField(session, "configOptions")
    .map(recordValue)
    .find(
      (option) =>
        stringField(option, "id") === "model" || stringField(option, "category") === "model"
    );
  if (modelOption) {
    const available = arrayField(modelOption, "options")
      .map((value) => stringField(recordValue(value), "value"))
      .filter((value): value is string => value !== undefined);
    assertAdvertisedModel(requestedModel, available);
    if (stringField(modelOption, "currentValue") === requestedModel) return undefined;
    return {
      method: "session/set_config_option",
      params: {
        sessionId,
        configId: stringField(modelOption, "id") ?? "model",
        value: requestedModel
      }
    };
  }

  const models = recordValue(session.models);
  if (Object.keys(models).length > 0) {
    const available = arrayField(models, "availableModels")
      .map((value) => stringField(recordValue(value), "modelId"))
      .filter((value): value is string => value !== undefined);
    assertAdvertisedModel(requestedModel, available);
    if (stringField(models, "currentModelId") === requestedModel) return undefined;
    return { method: "session/set_model", params: { sessionId, modelId: requestedModel } };
  }

  throw new Error("ACP provider does not advertise per-session model selection");
}

function assertAdvertisedModel(requestedModel: string, available: string[]): void {
  if (available.length > 0 && !available.includes(requestedModel)) {
    throw new Error(`ACP provider does not offer model ${requestedModel}`);
  }
}

function sessionModel(session: JsonRecord): string | undefined {
  const modelOption = arrayField(session, "configOptions")
    .map(recordValue)
    .find(
      (option) =>
        stringField(option, "id") === "model" || stringField(option, "category") === "model"
    );
  return (
    stringField(modelOption ?? {}, "currentValue") ??
    stringField(recordValue(session.models), "currentModelId") ??
    stringField(session, "model")
  );
}

export function normalizeAcpUpdate(update: StandardAcpUpdate, provider: string): CanonicalEvent[] {
  const type = update.sessionUpdate ?? update.type;
  if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
    const text = contentText(update.content) ?? update.text;
    if (!text) return [];
    return [
      {
        protocolVersion: 2,
        type: "message.delta",
        payload:
          type === "agent_thought_chunk"
            ? {
                text,
                channel: "analysis",
                exposure: "public_reasoning",
                provenance: { provider, nativeEvent: type }
              }
            : { text, channel: "final" }
      }
    ];
  }
  if (type === "tool_call") {
    if (!update.toolCallId) return [];
    if (acpToolTerminalStatus(update.status)) return normalizeAcpToolUpdate(update);
    const input = update.rawInput ?? update.input;
    return [
      {
        protocolVersion: 2,
        type: "tool_call.create",
        payload: {
          status: "running",
          id: update.toolCallId,
          name: update.name ?? update.title ?? "provider_tool",
          args: isRecord(input) ? input : input == null ? {} : { value: input }
        }
      }
    ];
  }
  if (type === "tool_call_update") {
    return normalizeAcpToolUpdate(update);
  }
  if (type === "usage" || type === "usage_update") {
    return [
      {
        protocolVersion: 2,
        type: "usage.update",
        payload: { ...update.usage, ...(update.model !== undefined ? { model: update.model } : {}) }
      }
    ];
  }
  return [];
}

export function createAcpAdapter(
  definition: AcpAdapterDefinition,
  {
    acpClientFactory = spawnAcpClient,
    command = definition.command
  }: {
    acpClientFactory?: typeof spawnAcpClient;
    command?: string;
  } = {}
) {
  const responders = new Map<string, AcpApprovalBridge>();
  return defineAdapter(
    {
      metadata: {
        mcp: true,
        type: definition.type,
        agentSources: ["provisioned"]
      },
      probe: () => probeCommand(command),
      async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
        const bridge = responders.get(invocationId);
        if (!bridge) throw new Error("INTERACTION_NOT_ACTIVE");
        await bridge.respond(response);
      },
      async *invoke(
        request: InvokeRequest,
        context?: AdapterInvocationContext
      ): AsyncGenerator<CanonicalEvent> {
        if (request.approvalMode !== "ask" && request.approvalMode !== "full_access")
          throw new Error("APPROVAL_MODE_UNSUPPORTED: this ACP adapter has no assisted policy");
        if (responders.has(request.invocationId)) throw new Error("INVOCATION_ALREADY_ACTIVE");
        const bridge = new AcpApprovalBridge(request);
        responders.set(request.invocationId, bridge);
        try {
          yield* bridge.stream(execute(request, bridge, context));
        } finally {
          bridge.close("execution_lost");
          responders.delete(request.invocationId);
        }
      }
    },
    null
  ); // ACP transports currently have no implemented reasoning setter.

  async function* execute(
    request: InvokeRequest,
    bridge: AcpApprovalBridge,
    context?: AdapterInvocationContext
  ): AsyncGenerator<CanonicalEvent> {
    const args =
      typeof definition.args === "function"
        ? definition.args(request)
        : (definition.args ?? ["acp"]);
    const runEnv = invocationEnvironment(request, definition.env?.(request));
    const mcp = invocationMcpServers(request, runEnv);
    assertMcpOptions(mcp, definition.type, []);
    const servers = Object.entries(mcp).map(([name, server]) =>
      server.type === "stdio"
        ? {
            name,
            command: server.command,
            args: server.args ?? [],
            env: Object.entries(server.env ?? {}).map(([name, value]) => ({ name, value }))
          }
        : {
            name,
            type: "http",
            url: server.url,
            headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value }))
          }
    );
    const client = acpClientFactory({
      command,
      args: [...args],
      env: runEnv,
      cwd: request.workdir,
      permissionHandler: (params) => bridge.requestPermission(params),
      onPermissionResponseWritten: (params) => bridge.responseWritten(params),
      onPermissionResponseFailed: (params, error) => bridge.responseFailed(params, error),
      ...(context?.streamLimits ? { streamLimits: context.streamLimits } : {})
    });
    bridge.bindTransport(() => client.close());
    let sessionId: string | undefined;
    let terminal = false;
    let forceCloseTimer: NodeJS.Timeout | undefined;
    const abort = (): void => {
      if (sessionId) client.cancel(sessionId);
      forceCloseTimer ??= setTimeout(() => {
        void client.close().catch(() => undefined);
      }, 250);
      forceCloseTimer.unref?.();
    };
    if (request.signal?.aborted) abort();
    else request.signal?.addEventListener("abort", abort, { once: true });

    try {
      const initialization = recordValue(
        await client.initialize({ protocolVersion: definition.protocolVersion ?? 1 })
      );
      if (
        servers.some((server) => server.type === "http") &&
        recordValue(recordValue(initialization.agentCapabilities).mcpCapabilities).http !== true
      )
        throw new Error(`MCP_TRANSPORT_UNSUPPORTED: ${definition.type}: http`);
      const imageSupported =
        recordValue(recordValue(initialization.agentCapabilities).promptCapabilities).image ===
        true;
      const inputs = [
        providerInputParts(request),
        ...(request.providerSession ? [providerInputParts(request, true)] : [])
      ];
      if (!imageSupported && inputs.some((parts) => parts.some((part) => part.type === "image"))) {
        throw new Error(
          "UNSUPPORTED_INPUT_MODALITY: ACP agent did not advertise promptCapabilities.image"
        );
      }
      const requestedSessionId = request.providerSession?.sessionId;
      let providerModel: string | undefined;
      let resumeFallback: string | undefined;
      let sessionMethod = requestedSessionId ? "session/load" : "session/new";
      let sessionParams = requestedSessionId
        ? acpLoadSessionParams(requestedSessionId, { cwd: request.workdir })
        : acpNewSessionParams({ cwd: request.workdir });
      sessionParams.mcpServers = servers;
      let sessionRequestId = client.reserveRequestId();
      let sessionResult: JsonRecord = {};

      let result = await client.request<JsonRecord | null>(sessionMethod, sessionParams, {
        requestId: sessionRequestId,
        ...(requestedSessionId ? { timeoutMs: 600_000 } : {})
      });
      const initialSessionId =
        requestedSessionId ?? (isRecord(result) ? stringField(result, "sessionId") : undefined);
      if (!initialSessionId) throw new Error("ACP session/new returned no sessionId");
      const missingLoadedSession =
        requestedSessionId &&
        (result === null ||
          (definition.emptyLoadResultMeansMissing === true &&
            isRecord(result) &&
            Object.keys(result).length === 0));
      if (missingLoadedSession) {
        resumeFallback = "session_load_not_found";
        sessionMethod = "session/new";
        sessionParams = acpNewSessionParams({ cwd: request.workdir });
        sessionParams.mcpServers = servers;
        sessionRequestId = client.reserveRequestId();
        result = await client.request<JsonRecord>(sessionMethod, sessionParams, {
          requestId: sessionRequestId
        });
        const freshSessionId = stringField(result, "sessionId");
        if (!freshSessionId) throw new Error("ACP session/new returned no sessionId");
      }
      sessionResult = isRecord(result) ? result : {};
      sessionId = resumeFallback
        ? stringField(sessionResult, "sessionId")
        : (requestedSessionId ?? stringField(sessionResult, "sessionId"));
      if (!sessionId) throw new Error("ACP session/new returned no sessionId");
      const requestedMode = contextActmode(request.context);
      if (requestedMode !== undefined) {
        const selection = acpActmodeSelectionRequest(sessionResult, sessionId, requestedMode);
        if (!selection.unchanged) await client.request(selection.method, selection.params);
        yield actmodeEvidence({
          requested: requestedMode,
          effective: selection.effective,
          nativeMode: selection.nativeMode,
          status: selection.effective === requestedMode ? "applied" : "fallback",
          ...(selection.effective !== requestedMode
            ? { reason: "provider_unsupported" as const }
            : {})
        });
      }
      const requestedModel = nonEmptyString(request.agentConfig?.model);
      if (requestedModel) {
        const selection = acpModelSelectionRequest(sessionResult, sessionId, requestedModel);
        if (selection) {
          const selectionRequestId = client.reserveRequestId();

          await client.request(selection.method, selection.params, {
            requestId: selectionRequestId
          });
        }
        providerModel = requestedModel;
      } else {
        providerModel = sessionModel(sessionResult);
      }

      yield {
        protocolVersion: 2,
        type: "session.update",
        payload: {
          providerSession: {
            sessionId,
            resumable: true,
            ...(resumeFallback
              ? {
                  resumeOutcome: "fresh_fallback",
                  resumeFallback,
                  contextInputVariant:
                    request.freshFallbackModelInputParts || request.freshFallbackModelInput
                      ? "recovery"
                      : "primary"
                }
              : {}),
            ...(providerModel ? { model: providerModel } : {})
          }
        }
      };

      const input = providerInputParts(request, resumeFallback !== undefined);
      // Preserve the legacy text call while mixed prompts retain every block's position.
      const prompt =
        input.length === 1 && input[0]?.type === "text"
          ? `${input[0].text}${initialControlInstructions(request, !requestedSessionId || resumeFallback !== undefined) ? `\n\n${initialControlInstructions(request, !requestedSessionId || resumeFallback !== undefined)}` : ""}`
          : [
              ...input,
              ...(initialControlInstructions(
                request,
                !requestedSessionId || resumeFallback !== undefined
              )
                ? [
                    {
                      type: "text" as const,
                      text: initialControlInstructions(
                        request,
                        !requestedSessionId || resumeFallback !== undefined
                      )
                    }
                  ]
                : [])
            ];
      const promptParams = acpPromptParams(sessionId, prompt);
      const promptRequestId = client.reserveRequestId();
      let stopReason: string | undefined;
      let finishReason: string | undefined;
      let promptResultPublicText: string | undefined;
      let producedFinalOutput = false;
      const activeTools = new Set<string>();
      const turn = new AcpTurnNormalizer(definition.provider);

      for await (const update of client.prompt(sessionId, prompt, {
        requestId: promptRequestId,
        params: promptParams
      })) {
        if (update.type === "prompt_result") {
          stopReason = update.stopReason;
          finishReason = update.finishReason;
          promptResultPublicText = promptResultText(update);
          continue;
        }
        const standardUpdate = update as StandardAcpUpdate;
        const events = turn.normalize(
          standardUpdate.sessionUpdate ?? standardUpdate.type,
          normalizeAcpUpdate(standardUpdate, definition.provider)
        );
        for (const event of events) {
          const id = stringField(event.payload, "id");
          if (
            event.type === "message.delta" &&
            event.payload.channel !== "analysis" &&
            typeof event.payload.text === "string" &&
            event.payload.text.length > 0
          ) {
            producedFinalOutput = true;
          }
          if (event.type === "tool_call.create" && id) activeTools.add(id);
          if (event.type === "tool_call.update" && id && isTerminalToolStatus(event.payload.status))
            activeTools.delete(id);
          yield event;
        }
      }

      const cancelled = request.signal?.aborted || isCancelledStopReason(stopReason);
      if (!cancelled && !producedFinalOutput && promptResultPublicText) {
        const fallbackEvents = turn.normalize(
          "agent_message_chunk",
          normalizeAcpUpdate(
            {
              type: "prompt_result",
              sessionUpdate: "agent_message_chunk",
              content: { text: promptResultPublicText }
            },
            definition.provider
          )
        );
        for (const event of fallbackEvents) yield event;
        producedFinalOutput = true;
      }
      if (cancelled) {
        for (const id of activeTools)
          yield {
            protocolVersion: 2,
            type: "tool_call.update",
            payload: { id, status: canonicalTerminalStatus("cancelled") }
          };
      }
      if (!cancelled && !producedFinalOutput) {
        for (const event of turn.finish("no-final-output", "failed")) yield event;
        yield {
          protocolVersion: 2,
          type: "message.update",
          payload: { role: "assistant", status: "failed" }
        };
        terminal = true;
        yield {
          protocolVersion: 2,
          type: "run.failed",
          payload: {
            code: "ACP_NO_FINAL_OUTPUT",
            message: `${definition.provider} completed without assistant output`,
            adapterType: definition.type
          }
        };
        return;
      }
      for (const event of turn.finish(
        stopReason ?? finishReason,
        cancelled ? "stopped" : "completed"
      ))
        yield event;
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: { role: "assistant", status: cancelled ? "stopped" : "completed" }
      };
      terminal = true;
      yield cancelled
        ? {
            protocolVersion: 2,
            type: "run.cancelled",
            payload: {
              reason: stopReason ?? String(request.signal?.reason ?? "cancelled"),
              ...(finishReason ? { finishReason } : {})
            }
          }
        : { protocolVersion: 2, type: "run.completed", payload: {} };
    } catch (error) {
      if (!terminal && request.signal?.aborted) {
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(request.signal.reason ?? "cancelled") }
        };
      } else {
        throw error;
      }
    } finally {
      request.signal?.removeEventListener("abort", abort);
      if (forceCloseTimer) clearTimeout(forceCloseTimer);
      await client.close();
    }
  }
}

function contentText(value: unknown): string | undefined {
  if (isRecord(value) && typeof value.text === "string") return value.text;
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(isRecord)
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join("");
  return text || undefined;
}

function promptResultText(update: StandardAcpUpdate): string | undefined {
  for (const value of [
    update.text,
    update.content,
    update.output,
    update.response,
    update.message
  ]) {
    if (typeof value === "string" && value) return value;
    const text = contentText(value);
    if (text) return text;
  }
  return undefined;
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

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function arrayField(value: JsonRecord, key: string): unknown[] {
  return Array.isArray(value[key]) ? value[key] : [];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringField(value: JsonRecord, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}
