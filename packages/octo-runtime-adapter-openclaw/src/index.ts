import {
  initialControlInstructions,
  hasImageInput,
  AcpApprovalBridge,
  DriverQueue,
  defineAdapter,
  invocationEnvs,
  mapReasoningEffort,
  providerInputText,
  type AdapterInvocationContext,
  type AdapterProbeOptions,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  canonicalTerminalStatus,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import { randomUUID } from "node:crypto";
import {
  OpenClawGatewayClient,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayEvent,
  type OpenClawGatewayOptions
} from "./gateway.js";
import { resolveOpenClawGateway, localGatewayFailure } from "./local-gateway.js";

type JsonRecord = Record<string, unknown>;

export const OPENCLAW_PROVIDER_OPTIONS = {
  url: "OPENCLAW_GATEWAY_URL",
  token: "OPENCLAW_GATEWAY_TOKEN",
  deviceId: "OPENCLAW_GATEWAY_DEVICE_ID",
  publicKey: "OPENCLAW_GATEWAY_PUBLIC_KEY",
  privateKey: "OPENCLAW_GATEWAY_PRIVATE_KEY"
} as const;

export interface OpenClawGatewayInvocation {
  gateway: OpenClawGatewayOptions;
  agentId: string;
  sessionKey: string;
  requestId: string;
  reconciliationDeadlineAt: number;
  createParams: JsonRecord;
  agentParams: JsonRecord;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function option(req: InvokeRequest, key: string): string | undefined {
  return nonEmptyString(req.agentConfig.providerOptions?.[key]);
}

function requiredOption(req: InvokeRequest, key: string): string {
  const value = option(req, key);
  if (!value) throw new Error(`OpenClaw adapter is not configured: missing ${key}`);
  return value;
}

/** The Gateway has a real system-prompt channel, so user content and Runtime instructions remain separate. */
export function composeOpenClawPrompt(req: InvokeRequest): string {
  return providerInputText(req);
}

export function buildOpenClawGatewayInvocation(req: InvokeRequest): OpenClawGatewayInvocation {
  if (hasImageInput(req))
    throw new Error("UNSUPPORTED_INPUT_MODALITY: openclaw does not encode image input");
  if (Object.keys(invocationEnvs(req)).length)
    throw new Error(
      "CONTEXT_ENVS_UNSUPPORTED: openclaw gateway has no per-run environment carrier"
    );
  const gatewayUrl = requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.url);
  const token = requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.token);
  const device: OpenClawDeviceIdentity = {
    deviceId: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.deviceId),
    publicKey: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.publicKey),
    privateKey: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.privateKey)
  };
  const agentId = req.agentConfig.providerAgentId;
  if (!agentId || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(agentId))
    throw new Error("OpenClaw provider_agent_id is required");
  const sessionKey = `agent:${agentId}:octo-run:${req.runId}:${randomUUID()}`;
  const requestId = `octo-runtime-${req.runId}-${randomUUID()}`;
  const message = composeOpenClawPrompt(req);
  const timeout = finiteNumber(req.agentConfig.timeoutSeconds);
  const model = nonEmptyString(req.agentConfig.model);
  const thinking = mapReasoningEffort("openclaw", req.agentConfig.effort);
  const timeoutMilliseconds = timeout && timeout > 0 ? timeout * 1_000 : 30 * 60_000;
  const reconciliationGraceMilliseconds = Math.min(30_000, timeoutMilliseconds * 0.1);
  const createParams: JsonRecord = {
    key: sessionKey,
    agentId,
    permissionMode: req.approvalMode === "full_access" ? "full" : "guarded",

    idempotencyKey: `${requestId}-session`,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {})
  };
  const agentParams: JsonRecord = {
    message,
    agentId,
    sessionKey,
    deliver: false,

    idempotencyKey: requestId,
    ...(initialControlInstructions(req)
      ? { extraSystemPrompt: initialControlInstructions(req) }
      : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(timeout === undefined ? {} : { timeout: Math.max(0, Math.floor(timeout)) })
  };
  return {
    gateway: { url: gatewayUrl, token, device },
    agentId,
    sessionKey,
    requestId,
    reconciliationDeadlineAt: Date.now() + timeoutMilliseconds + reconciliationGraceMilliseconds,
    createParams,
    agentParams
  };
}

interface EventQueueItem {
  event?: OpenClawGatewayEvent;
  error?: Error;
  done?: true;
  result?: unknown;
}

interface StreamState {
  lastSeq: number;
  assistantText: string;
  reasoningText: string;
  stepStarted: boolean;
  stepFinished: boolean;
  messageNumber: number;
  messages: Map<string, CanonicalEvent["payload"]>;
  assistantItemId?: string;
  tools: Set<string>;
}

function gatewayMessage(
  state: StreamState,
  channel: "analysis" | "final" | "commentary",
  nativeId?: string
): CanonicalEvent["payload"] {
  const key = channel === "commentary" ? `commentary:${nativeId ?? "preamble"}` : channel;
  let message = state.messages.get(key);
  if (!message) {
    message = {
      messageId: nativeId ? `openclaw:${nativeId}` : `openclaw:${channel}:${++state.messageNumber}`,
      channel,
      ...(channel === "analysis"
        ? {
            exposure: "public_reasoning",
            provenance: { provider: "openclaw", nativeEvent: "gateway.agent.thinking" }
          }
        : {})
    };
    state.messages.set(key, message);
  }
  return message;
}

function closeGatewayMessage(
  state: StreamState,
  key: string,
  status = "completed"
): CanonicalEvent[] {
  const message = state.messages.get(key);
  if (!message) return [];
  state.messages.delete(key);
  return [
    {
      protocolVersion: 2,
      type: "message.update",
      payload: { ...message, status: canonicalTerminalStatus(status) }
    }
  ];
}

function snapshotDelta(previous: string, next: string): { delta?: string; replacement?: string } {
  if (next === previous) return {};
  if (next.startsWith(previous)) return { delta: next.slice(previous.length) };
  return { replacement: next };
}

function usageEvent(data: JsonRecord): CanonicalEvent | undefined {
  const inputTokens = finiteNumber(data.inputTokens ?? data.input ?? data.promptTokens);
  const outputTokens = finiteNumber(
    data.outputTokens ?? data.output ?? data.completionTokens ?? data.tokens
  );
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    protocolVersion: 2,
    type: "usage.update",
    payload: {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      ...(nonEmptyString(data.provider) ? { provider: data.provider } : {}),
      ...(nonEmptyString(data.model) ? { model: data.model } : {})
    }
  };
}

function normalizeGatewayAgentEvent(payload: unknown, state: StreamState): CanonicalEvent[] {
  const native = asRecord(payload);
  const seq = finiteNumber(native?.seq);
  const stream = nonEmptyString(native?.stream);
  const data = asRecord(native?.data);
  if (
    !native ||
    seq === undefined ||
    !Number.isSafeInteger(seq) ||
    seq <= state.lastSeq ||
    !stream ||
    !data
  )
    return [];
  state.lastSeq = seq;
  const events: CanonicalEvent[] = [];
  const stepId = `openclaw:${nonEmptyString(native.runId) ?? "run"}`;
  const ensureStep = () => {
    if (state.stepStarted) return;
    state.stepStarted = true;
    events.push({ protocolVersion: 2, type: "model_step.started", payload: { stepId } });
  };

  if (stream === "lifecycle") {
    const phase = nonEmptyString(data.phase);
    if (phase === "start") ensureStep();
    if ((phase === "end" || phase === "error") && state.stepStarted && !state.stepFinished) {
      state.stepFinished = true;
      const finishReason = nonEmptyString(data.stopReason);
      events.push({
        protocolVersion: 2,
        type: "model_step.finished",
        payload: {
          stepId,
          status: canonicalTerminalStatus(
            phase === "error" ? "failed" : data.aborted === true ? "cancelled" : "completed"
          ),
          ...(finishReason ? { finishReason } : {})
        }
      });
    }
    return events;
  }

  ensureStep();
  if (stream === "assistant" && typeof data.text === "string") {
    events.push(...closeGatewayMessage(state, "analysis"));
    state.reasoningText = "";
    const nativeId = nonEmptyString(data.itemId);
    if (nativeId && nativeId !== state.assistantItemId) {
      events.push(...closeGatewayMessage(state, "final"));
      state.assistantText = "";
      state.assistantItemId = nativeId;
    }
    const message = gatewayMessage(state, "final", nativeId);
    const change = snapshotDelta(state.assistantText, data.text);
    state.assistantText = data.text;
    if (change.delta)
      events.push({
        protocolVersion: 2,
        type: "message.delta",
        payload: { ...message, text: change.delta, channel: "final" }
      });
    if (change.replacement !== undefined) {
      events.push({
        protocolVersion: 2,
        type: "message.update",
        payload: {
          ...message,
          role: "assistant",
          status: "streaming",
          text: change.replacement,
          channel: "final"
        }
      });
    }
  } else if (stream === "thinking" && typeof data.text === "string") {
    const message = gatewayMessage(state, "analysis");
    const change = snapshotDelta(state.reasoningText, data.text);
    state.reasoningText = data.text;
    const text = change.delta ?? change.replacement;
    if (text) {
      events.push({
        protocolVersion: 2,
        type: change.replacement === undefined ? "message.delta" : "message.update",
        payload: {
          ...message,
          role: "assistant",
          status: "streaming",
          text,
          channel: "analysis",
          exposure: "public_reasoning",
          provenance: { provider: "openclaw", nativeEvent: "gateway.agent.thinking" }
        }
      });
    }
  } else if (stream === "thinking" && finiteNumber(data.progressTokens) !== undefined) {
    if (!state.messages.has("analysis")) {
      events.push({
        protocolVersion: 2,
        type: "message.create",
        payload: { ...gatewayMessage(state, "analysis"), status: "streaming", exposure: "unknown" }
      });
    }
  } else if (stream === "tool") {
    const phase = nonEmptyString(data.phase);
    const id = nonEmptyString(data.toolCallId);
    if (!id) return events;
    if (phase === "start") {
      if (state.tools.has(id)) return events;
      state.tools.add(id);
      events.push(...closeGatewayMessage(state, "analysis"));
      state.reasoningText = "";
      events.push({
        protocolVersion: 2,
        type: "tool_call.create",
        payload: {
          status: "running",
          id,
          name: nonEmptyString(data.name) ?? "tool",
          args: asRecord(data.args) ?? {}
        }
      });
    } else if (phase === "update") {
      events.push({
        protocolVersion: 2,
        type: "tool_call.delta",
        payload: {
          id,
          outputSnapshot:
            typeof (data.result ?? data.partialResult) === "string"
              ? String(data.result ?? data.partialResult)
              : JSON.stringify(data.result ?? data.partialResult ?? "")
        }
      });
    } else if (phase === "result") {
      events.push({
        protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id,
          ...(nonEmptyString(data.name) ? { name: data.name } : {}),
          status: canonicalTerminalStatus(data.isError === true ? "error" : "completed"),
          output: data.result
        }
      });
    }
  } else if (
    stream === "item" &&
    data.kind === "preamble" &&
    typeof data.progressText === "string"
  ) {
    const nativeId = nonEmptyString(data.itemId);
    const message = gatewayMessage(state, "commentary", nativeId);
    events.push({
      protocolVersion: 2,
      type: "message.update",
      payload: {
        ...message,
        text: data.progressText,
        status: data.phase === "end" ? "completed" : "streaming"
      }
    });
  } else if (stream === "usage") {
    const event = usageEvent(data);
    if (event) events.push(event);
  }
  return events;
}

function terminalState(payload: unknown): "completed" | "failed" | "cancelled" | undefined {
  const native = asRecord(payload);
  if (native?.stream !== "lifecycle") return undefined;
  const data = asRecord(native.data);
  const phase = nonEmptyString(data?.phase);
  if (phase === "error") return data?.aborted === true ? "cancelled" : "failed";
  if (phase === "end") return data?.aborted === true ? "cancelled" : "completed";
  return undefined;
}

function terminalError(payload: unknown): string {
  return (
    nonEmptyString(asRecord(asRecord(payload)?.data)?.error) ?? "OpenClaw Gateway agent run failed"
  );
}

async function waitForConfirmedTerminal(
  client: OpenClawGatewayClientLike,
  runId: string,
  expected: "completed" | "failed" | "cancelled",
  deadlineAt: number
): Promise<void> {
  while (Date.now() < deadlineAt) {
    const waitMs = Math.max(1, Math.min(30_000, deadlineAt - Date.now()));
    const result = asRecord(
      await client.request(
        "agent.wait",
        { runId, timeoutMs: waitMs },
        { timeoutMs: waitMs + 2_000 }
      )
    );
    const status = nonEmptyString(result?.status);
    const stopReason = nonEmptyString(result?.stopReason);
    const endedAt = finiteNumber(result?.endedAt);
    const cancelled =
      endedAt !== undefined && (stopReason === "aborted" || stopReason === "restart");
    const actual = cancelled
      ? "cancelled"
      : status === "ok"
        ? "completed"
        : status === "error" || (status === "timeout" && endedAt !== undefined)
          ? "failed"
          : undefined;
    if (actual === expected) return;
    if (!actual && (status === "pending" || status === "timeout")) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(250, Math.max(0, deadlineAt - Date.now())))
      );
      continue;
    }
    const error = nonEmptyString(result?.error);
    throw new Error(
      error
        ? `OpenClaw Gateway confirmed ${actual ?? status ?? "unknown"}, not ${expected}: ${error}`
        : `OpenClaw Gateway confirmed ${actual ?? status ?? "unknown"}, not ${expected}`
    );
  }
  throw new Error(`OpenClaw Gateway did not confirm ${expected} before the invocation deadline`);
}

function normalizeFinalResponse(
  value: unknown,
  state: StreamState
): {
  events: CanonicalEvent[];
  terminal?: "completed" | "failed" | "cancelled";
  error?: string;
} {
  const response = asRecord(value);
  const result = asRecord(response?.result);
  const meta = asRecord(result?.meta);
  const agentMeta = asRecord(meta?.agentMeta);
  const events: CanonicalEvent[] = [];
  const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
  const finalText = payloads
    .map((item) => nonEmptyString(asRecord(item)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
  const ensureStep = () => {
    if (state.stepStarted) return;
    state.stepStarted = true;
    events.push({
      protocolVersion: 2,
      type: "model_step.started",
      payload: { stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}` }
    });
  };
  if (finalText) {
    ensureStep();
    const message = gatewayMessage(state, "final", state.assistantItemId);
    const change = snapshotDelta(state.assistantText, finalText);
    state.assistantText = finalText;
    if (change.delta)
      events.push({
        protocolVersion: 2,
        type: "message.delta",
        payload: { ...message, text: change.delta, channel: "final" }
      });
    if (change.replacement !== undefined) {
      events.push({
        protocolVersion: 2,
        type: "message.update",
        payload: {
          ...message,
          role: "assistant",
          status: "streaming",
          text: change.replacement,
          channel: "final"
        }
      });
    }
  }
  const usage = asRecord(agentMeta?.usage);
  const usageUpdate = usageEvent({
    inputTokens: usage?.input,
    outputTokens: usage?.output,
    provider: agentMeta?.provider,
    model: agentMeta?.model
  });
  if (usageUpdate) events.push(usageUpdate);

  const status = nonEmptyString(response?.status);
  const terminal =
    status === "ok"
      ? meta?.aborted === true
        ? "cancelled"
        : "completed"
      : status
        ? "failed"
        : undefined;
  if (terminal && !state.stepFinished) {
    ensureStep();
    state.stepFinished = true;
    events.push({
      protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}`,
        status: canonicalTerminalStatus(
          terminal === "cancelled" ? "cancelled" : terminal === "failed" ? "failed" : "completed"
        ),
        ...(nonEmptyString(meta?.stopReason)
          ? { finishReason: nonEmptyString(meta?.stopReason) }
          : {})
      }
    });
  }
  return {
    events,
    terminal,
    ...(terminal === "failed"
      ? { error: nonEmptyString(response?.summary) ?? "OpenClaw Gateway agent run failed" }
      : {})
  };
}

function assertRuntimeGatewayContract(value: unknown): void {
  const hello = asRecord(value);
  const features = asRecord(hello?.features);
  const methods = Array.isArray(features?.methods) ? features.methods : [];
  const events = Array.isArray(features?.events) ? features.events : [];
  if (hello?.protocol !== 4)
    throw new Error(`unsupported OpenClaw Gateway protocol: ${String(hello?.protocol)}`);
  const requiredMethods = [
    "sessions.create",
    "sessions.messages.subscribe",
    "agent",
    "agent.wait",
    "sessions.abort"
  ];
  requiredMethods.unshift("agents.list");
  for (const method of requiredMethods) {
    if (!methods.includes(method))
      throw new Error(`OpenClaw Gateway does not advertise required method ${method}`);
  }
  if (!events.includes("agent"))
    throw new Error("OpenClaw Gateway does not advertise the agent event stream");
}

export interface OpenClawGatewayClientLike {
  connect(): Promise<unknown>;
  onEvent(listener: (event: OpenClawGatewayEvent) => void): () => void;
  request(
    method: string,
    params: JsonRecord,
    options?: {
      expectFinal?: boolean;
      timeoutMs?: number | null;
      signal?: AbortSignal;
      onAccepted?: (value: unknown) => void;
    }
  ): Promise<unknown>;
  close(): Promise<void>;
}

type GatewayClientFactory = (options: OpenClawGatewayOptions) => OpenClawGatewayClientLike;

async function* invokeOpenClawGateway(
  req: InvokeRequest,
  invocation: OpenClawGatewayInvocation,
  context: AdapterInvocationContext | undefined,
  clientFactory: GatewayClientFactory,
  permissions: AcpApprovalBridge
): AsyncGenerator<CanonicalEvent> {
  const client = clientFactory(invocation.gateway);
  const requestAbort = new AbortController();
  let resourceFailure = false;
  let terminal: "completed" | "failed" | "cancelled" | undefined;
  let closing: Promise<void> | undefined;
  const stop = (cancel = false): Promise<void> => {
    if (closing) return closing;
    unsubscribe();
    requestAbort.abort();
    closing = (async () => {
      if (cancel && agentAccepted)
        await client
          .request(
            "sessions.abort",
            {
              key: providerSessionKey,
              runId: acceptedRunId,
              agentId: invocation.agentId
            },
            { timeoutMs: 5000 }
          )
          .catch(() => undefined);
      await client.close();
    })();
    // A paused consumer must not leave a rejected cleanup promise unobserved.
    void closing.catch(() => undefined);
    return closing;
  };
  permissions.bindTransport(() => stop(!terminal));
  const queue = new DriverQueue<EventQueueItem>({
    discardOnFailure: true,
    limits: context?.streamLimits,
    boundary: "openclaw.event_queue",
    onFailure: () => {
      resourceFailure = true;
      void stop(true);
    }
  });
  const iterator = queue[Symbol.asyncIterator]();
  let acceptedRunId = invocation.requestId;
  let agentAccepted = false;
  const seenApprovals = new Set<string>();
  const activeApprovals = new Map<string, JsonRecord>();
  let providerSessionKey = invocation.sessionKey;
  const routedApprovals = new Set<string>();
  const acceptEvent = (event: OpenClawGatewayEvent): void => {
    if (closing) return;
    const payload = asRecord(event.payload);
    if (event.event === "agent") {
      const runId = nonEmptyString(payload?.runId);
      if (runId !== acceptedRunId && runId !== invocation.requestId) return;
    } else if (event.event === "exec.approval.requested") {
      const request = asRecord(payload?.request);
      const id = nonEmptyString(payload?.id);
      if (!id || routedApprovals.has(id) || request?.sessionKey !== providerSessionKey) return;
      if (
        request.runId &&
        request.runId !== acceptedRunId &&
        request.runId !== invocation.requestId
      )
        return;
      if (routedApprovals.size >= 1024) {
        queue.fail(new Error("APPROVAL_WAIT_UNAVAILABLE"));
        return;
      }
      routedApprovals.add(id);
    } else if (event.event === "exec.approval.resolved") {
      const id = nonEmptyString(payload?.id);
      // A resolution can arrive before the consumer has processed its request.
      if (!id || (!routedApprovals.has(id) && !activeApprovals.has(id))) return;
    } else return;
    queue.push({ event });
  };
  const unsubscribe = client.onEvent(acceptEvent);
  const onAbort = (): void => queue.fail(new Error("OpenClaw invocation aborted"));
  req.signal?.addEventListener("abort", onAbort, { once: true });
  const state: StreamState = {
    lastSeq: -1,
    assistantText: "",
    reasoningText: "",
    stepStarted: false,
    stepFinished: false,
    messageNumber: 0,
    messages: new Map(),
    tools: new Set()
  };
  try {
    const hello = await client.connect();
    assertRuntimeGatewayContract(hello);
    if (req.approvalMode === "ask") {
      const features = asRecord(asRecord(hello)?.features);
      if (
        !Array.isArray(features?.methods) ||
        !features.methods.includes("exec.approval.resolve") ||
        !features.methods.includes("exec.approval.list") ||
        !Array.isArray(features.events) ||
        !features.events.includes("exec.approval.requested") ||
        !features.events.includes("exec.approval.resolved")
      ) {
        throw new Error("APPROVAL_MODE_UNSUPPORTED: OpenClaw Gateway has no approval transport");
      }
    }
    await assertExistingAgent(client, invocation.agentId, req.signal);
    const created = asRecord(
      await client.request("sessions.create", invocation.createParams, {
        timeoutMs: 30_000,
        signal: req.signal
      })
    );
    providerSessionKey = nonEmptyString(created?.key) ?? invocation.sessionKey;
    invocation.agentParams.sessionKey = providerSessionKey;
    await client.request(
      "sessions.messages.subscribe",
      {
        key: providerSessionKey,
        agentId: invocation.agentId
      },
      { timeoutMs: 10_000, signal: req.signal }
    );
    if (req.approvalMode === "ask") {
      const pending = await client.request(
        "exec.approval.list",
        {},
        { timeoutMs: 10_000, signal: req.signal }
      );
      if (!Array.isArray(pending))
        throw new Error("OpenClaw Gateway returned invalid pending approvals");
      for (const payload of pending) acceptEvent({ event: "exec.approval.requested", payload });
    }
    yield {
      protocolVersion: 2,
      type: "session.update",
      payload: {
        providerSession: {
          sessionId: providerSessionKey,
          resumable: false,
          agentId: invocation.agentId
        }
      }
    };

    const request = client.request("agent", invocation.agentParams, {
      expectFinal: true,
      timeoutMs: null,
      signal: AbortSignal.any([requestAbort.signal, ...(req.signal ? [req.signal] : [])]),
      onAccepted: (value) => {
        agentAccepted = true;
        const runId = nonEmptyString(asRecord(value)?.runId);
        if (runId) acceptedRunId = runId;
      }
    });
    void request.then(
      (result) => queue.push({ done: true, result }),
      (error) => queue.push({ error: error instanceof Error ? error : new Error(String(error)) })
    );

    while (!terminal) {
      const next = await iterator.next();
      if (next.done) throw new Error("OpenClaw event queue closed before terminal");
      const item = next.value;
      if (item.error) throw item.error;
      if (item.done) {
        const reconciled = normalizeFinalResponse(item.result, state);
        for (const event of reconciled.events) yield event;
        terminal = reconciled.terminal;
        if (terminal === "failed") throw new Error(reconciled.error);
        break;
      }
      if (item.event?.event === "exec.approval.resolved") {
        const payload = asRecord(item.event.payload);
        const id = nonEmptyString(payload?.id);
        if (!id) continue;
        const params = activeApprovals.get(id);
        if (!params) continue;
        permissions.resolveFromProvider(
          params,
          payload?.decision == null ? "expired" : "resolved",
          payload?.decision === "deny"
            ? "declined"
            : ["allow-once", "allow-always"].includes(String(payload?.decision))
              ? "accepted"
              : undefined
        );
        activeApprovals.delete(id);
        continue;
      }
      if (item.event?.event === "exec.approval.requested") {
        const payload = asRecord(item.event.payload);
        const approvalRequest = asRecord(payload?.request);
        // Gateway approval events are broadcast. Only this invocation's session may be answered.
        if (approvalRequest?.sessionKey !== providerSessionKey || typeof payload?.id !== "string")
          continue;
        if (
          approvalRequest.runId &&
          approvalRequest.runId !== acceptedRunId &&
          approvalRequest.runId !== invocation.requestId
        )
          continue;
        const id = payload.id;
        if (seenApprovals.has(id)) continue;
        seenApprovals.add(id);
        if (seenApprovals.size > 1024) throw new Error("APPROVAL_WAIT_UNAVAILABLE");
        const expiresAt = finiteNumber(payload.expiresAtMs);
        if (expiresAt === undefined || expiresAt <= Date.now()) continue;
        const allowed = Array.isArray(approvalRequest.allowedDecisions)
          ? approvalRequest.allowedDecisions
          : [];
        const options = [
          ...(allowed.includes("allow-once")
            ? [{ kind: "allow_once", optionId: "allow-once" }]
            : []),
          ...(allowed.includes("allow-always")
            ? [{ kind: "allow_always", optionId: "allow-always" }]
            : []),
          ...(allowed.includes("deny") ? [{ kind: "reject_once", optionId: "deny" }] : [])
        ];
        const params = {
          toolCall: {
            toolCallId: nonEmptyString(approvalRequest.toolCallId) ?? id,
            title: nonEmptyString(approvalRequest.command) ?? "OpenClaw command"
          },
          providerDetails: {
            provider: "openclaw",
            method: "exec.approval.resolve",
            approvalId: id,
            command: approvalRequest.command,
            cwd: approvalRequest.cwd,
            reason: approvalRequest.warningText,
            description: [approvalRequest.host, approvalRequest.nodeId]
              .filter((value) => typeof value === "string" && value)
              .join(" · "),
            options
          },
          options
        };
        activeApprovals.set(id, params);
        void permissions
          .requestPermission(params, finiteNumber(payload.expiresAtMs))
          .then(async (result) => {
            if (result.providerResolved) {
              activeApprovals.delete(id);
              return;
            }
            const decision = nonEmptyString(asRecord(result.outcome)?.optionId) ?? "deny";
            await client.request(
              "exec.approval.resolve",
              { id, decision },
              { timeoutMs: 10_000, signal: req.signal }
            );
            permissions.responseWritten(params);
            activeApprovals.delete(id);
          })
          .catch((error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            permissions.responseFailed(params, failure);
            queue.push({ error: failure });
          });
        continue;
      }
      if (!item.event || item.event.event !== "agent") continue;
      const native = asRecord(item.event.payload);
      const runId = nonEmptyString(native?.runId);
      if (!runId || (runId !== acceptedRunId && runId !== invocation.requestId)) continue;
      const events = normalizeGatewayAgentEvent(item.event.payload, state);
      for (const event of events) yield event;
      terminal = terminalState(item.event.payload);
      if (terminal) {
        await waitForConfirmedTerminal(
          client,
          runId,
          terminal,
          invocation.reconciliationDeadlineAt
        );
        if (terminal === "failed") throw new Error(terminalError(item.event.payload));
      }
    }

    if (req.signal?.aborted || terminal === "cancelled") {
      yield {
        protocolVersion: 2,
        type: "message.update",
        payload: {
          ...gatewayMessage(state, "final", state.assistantItemId),
          role: "assistant",
          status: "stopped",
          text: state.assistantText,
          channel: "final"
        }
      };
      yield {
        protocolVersion: 2,
        type: "run.cancelled",
        payload: { reason: String(req.signal?.reason ?? "openclaw_aborted") }
      };
      return;
    }
    if (terminal !== "completed")
      throw new Error("OpenClaw Gateway stream ended without a terminal lifecycle event");
    yield {
      protocolVersion: 2,
      type: "message.update",
      payload: {
        ...gatewayMessage(state, "final", state.assistantItemId),
        role: "assistant",
        status: "completed",
        text: state.assistantText,
        channel: "final"
      }
    };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } catch (error) {
    if (req.signal?.aborted) {
      if (!agentAccepted) {
        yield {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            ...gatewayMessage(state, "final", state.assistantItemId),
            role: "assistant",
            status: "stopped",
            text: state.assistantText,
            channel: "final"
          }
        };
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(req.signal.reason ?? "openclaw_aborted_before_dispatch") }
        };
        return;
      }
      let recoveryClient: OpenClawGatewayClientLike | undefined;
      try {
        const abortParams = {
          key: providerSessionKey,
          runId: acceptedRunId,
          agentId: invocation.agentId
        };
        let controlClient = client;
        try {
          await controlClient.request("sessions.abort", abortParams, { timeoutMs: 5_000 });
        } catch {
          recoveryClient = clientFactory(invocation.gateway);
          assertRuntimeGatewayContract(await recoveryClient.connect());
          controlClient = recoveryClient;
          await controlClient.request("sessions.abort", abortParams, { timeoutMs: 5_000 });
        }
        await waitForConfirmedTerminal(
          controlClient,
          acceptedRunId,
          "cancelled",
          Date.now() + 30_000
        );
        yield {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            ...gatewayMessage(state, "final", state.assistantItemId),
            role: "assistant",
            status: "stopped",
            text: state.assistantText,
            channel: "final"
          }
        };
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(req.signal.reason ?? "openclaw_aborted") }
        };
      } catch (abortError) {
        const message =
          abortError instanceof Error
            ? abortError.message
            : "OpenClaw Gateway abort confirmation failed";
        yield {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            ...gatewayMessage(state, "final", state.assistantItemId),
            role: "assistant",
            status: "failed",
            text: state.assistantText,
            channel: "final"
          }
        };
        yield {
          protocolVersion: 2,
          type: "run.failed",
          payload: { message, adapterType: "openclaw" }
        };
      } finally {
        await recoveryClient?.close();
      }
      return;
    }
    let message = error instanceof Error ? error.message : String(error);
    if (!resourceFailure && agentAccepted && terminal !== "failed" && terminal !== "cancelled") {
      const recoveryClient = clientFactory(invocation.gateway);
      try {
        assertRuntimeGatewayContract(await recoveryClient.connect());
        await waitForConfirmedTerminal(
          recoveryClient,
          acceptedRunId,
          "completed",
          invocation.reconciliationDeadlineAt
        );
        yield {
          protocolVersion: 2,
          type: "message.update",
          payload: {
            ...gatewayMessage(state, "final", state.assistantItemId),
            role: "assistant",
            status: "completed",
            text: state.assistantText,
            channel: "final"
          }
        };
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
        return;
      } catch (recoveryError) {
        const detail =
          recoveryError instanceof Error ? recoveryError.message : "unknown reconciliation failure";
        message = `${message}; reconnect reconciliation failed: ${detail}`;
      } finally {
        await recoveryClient.close();
      }
    }
    yield {
      protocolVersion: 2,
      type: "message.update",
      payload: {
        ...gatewayMessage(state, "final", state.assistantItemId),
        role: "assistant",
        status: "failed",
        text: state.assistantText,
        channel: "final"
      }
    };
    yield { protocolVersion: 2, type: "run.failed", payload: { message, adapterType: "openclaw" } };
  } finally {
    req.signal?.removeEventListener("abort", onAbort);
    queue.close();
    queue.drain();
    routedApprovals.clear();
    activeApprovals.clear();
    await stop(!terminal);
  }
}

export function createOpenClawAdapter({
  clientFactory = (options) => new OpenClawGatewayClient(options)
}: { clientFactory?: GatewayClientFactory } = {}) {
  const responders = new Map<string, AcpApprovalBridge>();
  const probeGateway = async (options?: AdapterProbeOptions) => {
    let client: OpenClawGatewayClientLike | undefined;
    try {
      client = clientFactory(await resolveOpenClawGateway(options?.providerOptions));
      assertRuntimeGatewayContract(await client.connect());
      await client.request("agents.list", {});
      return { available: true, command: "openclaw-gateway" };
    } catch (error) {
      return { available: false, command: "openclaw-gateway", reason: localGatewayFailure(error) };
    } finally {
      await client?.close();
    }
  };
  return defineAdapter({
    metadata: {
      type: "openclaw",
      workspace: false,
      processModel: "websocket-per-invocation",
      transport: "openclaw-gateway-rpc",
      agentSources: ["preset", "provisioned"]
    },
    probe: probeGateway,
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
        throw new Error("UNSUPPORTED_INPUT_MODALITY: openclaw does not encode image input");
      if (req.approvalMode === "assisted")
        throw new Error("APPROVAL_MODE_UNSUPPORTED: OpenClaw has no qualified assisted policy");
      if (responders.has(req.invocationId)) throw new Error("INVOCATION_ALREADY_ACTIVE");
      const gateway = await resolveOpenClawGateway(req.agentConfig.providerOptions);
      req = {
        ...req,
        agentConfig: {
          ...req.agentConfig,
          providerOptions: {
            ...req.agentConfig.providerOptions,
            [OPENCLAW_PROVIDER_OPTIONS.url]: gateway.url,
            [OPENCLAW_PROVIDER_OPTIONS.token]: gateway.token,
            [OPENCLAW_PROVIDER_OPTIONS.deviceId]: gateway.device.deviceId,
            [OPENCLAW_PROVIDER_OPTIONS.publicKey]: gateway.device.publicKey,
            [OPENCLAW_PROVIDER_OPTIONS.privateKey]: gateway.device.privateKey
          }
        }
      };
      const invocation = buildOpenClawGatewayInvocation(req);
      const bridge = new AcpApprovalBridge(req, 600_000, {
        providerDecisions: true,
        providerManagedExpiry: true
      });
      responders.set(req.invocationId, bridge);
      try {
        yield* bridge.stream(
          invokeOpenClawGateway(req, invocation, context, clientFactory, bridge)
        );
      } finally {
        bridge.close("execution_lost");
        responders.delete(req.invocationId);
      }
    }
  });
}

async function assertExistingAgent(
  client: OpenClawGatewayClientLike,
  agentId: string,
  signal?: AbortSignal
): Promise<void> {
  const result = asRecord(await client.request("agents.list", {}, { timeoutMs: 1_000, signal }));
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  if (!agents.some((agent) => asRecord(agent)?.id === agentId))
    throw new Error(`OpenClaw agent ${agentId} is missing`);
}

export {
  loadLocalOpenClawGateway,
  configureOpenClawConnection,
  readOpenClawConnection,
  LocalGatewayError,
  normalizeOpenClawGatewayUrl,
  resolveOpenClawGateway,
  OPENCLAW_RUNTIME_ROOT,
  type OpenClawConnectionInput,
  type OpenClawConnection
} from "./local-gateway.js";

export {
  OpenClawGatewayClient,
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayEvent,
  type OpenClawGatewayOptions
} from "./gateway.js";
export {
  OpenClawTranscriptNormalizer,
  normalizeOpenClawFrame,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  tryParseOpenClawTranscriptLine
} from "./parser.js";

export const openclawAdapter = createOpenClawAdapter();
export default openclawAdapter;
