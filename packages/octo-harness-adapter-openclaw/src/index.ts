import { canonicalTerminalStatus } from "@mininglamp-oss/octo-harness-protocol";
import { randomUUID } from "node:crypto";
import {
  defineAdapter,
  observeBestEffort,
  observeProviderOutput,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest,
  type ProviderCarrier
} from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  OpenClawGatewayClient,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayEvent,
  type OpenClawGatewayOptions
} from "./gateway.js";
import { loadLocalOpenClawGateway, localGatewayFailure } from "./local-gateway.js";

type JsonRecord = Record<string, unknown>;

export const OPENCLAW_PROVIDER_OPTIONS = {
  url: "OPENCLAW_GATEWAY_URL",
  token: "OPENCLAW_GATEWAY_TOKEN",
  deviceId: "OPENCLAW_GATEWAY_DEVICE_ID",
  publicKey: "OPENCLAW_GATEWAY_PUBLIC_KEY",
  privateKey: "OPENCLAW_GATEWAY_PRIVATE_KEY",
  agentId: "OPENCLAW_AGENT_ID",
  workspace: "OPENCLAW_RUNNER_WORKSPACE",
  bindingId: "OCTO_EXTERNAL_BINDING_ID"
} as const;

export interface OpenClawGatewayInvocation {
  gateway: OpenClawGatewayOptions;
  agentId: string;
  runnerWorkspace?: string;
  sessionKey: string;
  requestId: string;
  reconciliationDeadlineAt: number;
  createParams: JsonRecord;
  agentParams: JsonRecord;
  providerInput: ProviderCarrier;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
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

/** The Gateway has a real system-prompt channel, so user content and Harness instructions remain separate. */
export function composeOpenClawPrompt(req: InvokeRequest): string {
  return providerInputText(req);
}

export function buildOpenClawGatewayInvocation(req: InvokeRequest): OpenClawGatewayInvocation {
  const gatewayUrl = requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.url);
  const token = requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.token);
  const device: OpenClawDeviceIdentity = {
    deviceId: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.deviceId),
    publicKey: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.publicKey),
    privateKey: requiredOption(req, OPENCLAW_PROVIDER_OPTIONS.privateKey)
  };
  const agentId = req.agentConfig.providerAgentId;
  if (!agentId || !/^[a-z0-9_][a-z0-9_-]{0,63}$/.test(agentId)) throw new Error("OpenClaw provider_agent_id is required");
  const runnerWorkspace = option(req, OPENCLAW_PROVIDER_OPTIONS.workspace);
  const sessionKey = `agent:${agentId}:octo-run:${req.runId}:${randomUUID()}`;
  const requestId = `octo-harness-${req.runId}-${randomUUID()}`;
  const message = composeOpenClawPrompt(req);
  const timeout = finiteNumber(req.agentConfig.timeoutSeconds);
  const model = nonEmptyString(req.agentConfig.model);
  const thinking = nonEmptyString(req.agentConfig.effort);
  const timeoutMilliseconds = timeout && timeout > 0 ? timeout * 1_000 : 30 * 60_000;
  const reconciliationGraceMilliseconds = Math.min(30_000, timeoutMilliseconds * 0.1);
  const createParams: JsonRecord = {
    key: sessionKey,
    agentId,
    ...(!usesExistingAgent(req) ? { cwd: req.workdir } : {}),
    idempotencyKey: `${requestId}-session`,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {})
  };
  const agentParams: JsonRecord = {
    message,
    agentId,
    sessionKey,
    deliver: false,
    ...(!usesExistingAgent(req) ? { promptMode: "minimal" } : {}),
    idempotencyKey: requestId,
    ...(req.controlInstructions ? { extraSystemPrompt: req.controlInstructions } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(timeout === undefined ? {} : { timeout: Math.max(0, Math.floor(timeout)) })
  };
  return {
    gateway: { url: gatewayUrl, token, device },
    agentId,
    ...(runnerWorkspace ? { runnerWorkspace } : {}),
    sessionKey,
    requestId,
    reconciliationDeadlineAt: Date.now() + timeoutMilliseconds + reconciliationGraceMilliseconds,
    createParams,
    agentParams,
    providerInput: {
      kind: "json_params",
      content: {
        operations: [
          ...(!usesExistingAgent(req) ? [{ method: "config.get", params: {} }] : [{ method: "agents.list", params: {} }]),
          { method: "sessions.create", params: createParams },
          { method: "sessions.messages.subscribe", params: { key: sessionKey, agentId } },
          { method: "agent", params: agentParams }
        ],
        // Authentication is deliberately absent from the captured provider carrier.
        gatewayUrl
      }
    }
  };
}

interface EventQueueItem {
  event?: OpenClawGatewayEvent;
  error?: Error;
  done?: true;
  result?: unknown;
}

class EventQueue {
  readonly #items: EventQueueItem[] = [];
  readonly #waiters: Array<(value: EventQueueItem) => void> = [];

  push(value: EventQueueItem): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter(value);
    else this.#items.push(value);
  }

  next(): Promise<EventQueueItem> {
    const value = this.#items.shift();
    return value ? Promise.resolve(value) : new Promise(resolve => this.#waiters.push(resolve));
  }
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

function gatewayMessage(state: StreamState, channel: "analysis" | "final" | "commentary", nativeId?: string): CanonicalEvent["payload"] {
  const key = channel === "commentary" ? `commentary:${nativeId ?? "preamble"}` : channel;
  let message = state.messages.get(key);
  if (!message) {
    message = { messageId: nativeId ? `openclaw:${nativeId}` : `openclaw:${channel}:${++state.messageNumber}`, channel,
      ...(channel === "analysis" ? { exposure: "public_reasoning", provenance: { provider: "openclaw", nativeEvent: "gateway.agent.thinking" } } : {}) };
    state.messages.set(key, message);
  }
  return message;
}

function closeGatewayMessage(state: StreamState, key: string, status = "completed"): CanonicalEvent[] {
  const message = state.messages.get(key);
  if (!message) return [];
  state.messages.delete(key);
  return [{ protocolVersion: 2, type: "message.update", payload: { ...message, status: canonicalTerminalStatus(status) } }];
}

function snapshotDelta(previous: string, next: string): { delta?: string; replacement?: string } {
  if (next === previous) return {};
  if (next.startsWith(previous)) return { delta: next.slice(previous.length) };
  return { replacement: next };
}

function usageEvent(data: JsonRecord): CanonicalEvent | undefined {
  const inputTokens = finiteNumber(data.inputTokens ?? data.input ?? data.promptTokens);
  const outputTokens = finiteNumber(data.outputTokens ?? data.output ?? data.completionTokens ?? data.tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { protocolVersion: 2,
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
  if (!native || seq === undefined || !Number.isSafeInteger(seq) || seq <= state.lastSeq || !stream || !data) return [];
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
      events.push({ protocolVersion: 2,
        type: "model_step.finished",
        payload: {
          stepId,
          status: canonicalTerminalStatus(phase === "error" ? "failed" : data.aborted === true ? "cancelled" : "completed"),
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
    if (change.delta) events.push({ protocolVersion: 2, type: "message.delta", payload: { ...message, text: change.delta, channel: "final" } });
    if (change.replacement !== undefined) {
      events.push({ protocolVersion: 2, type: "message.update", payload: { ...message, role: "assistant", status: "streaming", text: change.replacement, channel: "final" } });
    }
  } else if (stream === "thinking" && typeof data.text === "string") {
    const message = gatewayMessage(state, "analysis");
    const change = snapshotDelta(state.reasoningText, data.text);
    state.reasoningText = data.text;
    const text = change.delta ?? change.replacement;
    if (text) {
      events.push({ protocolVersion: 2,
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
      events.push({ protocolVersion: 2, type: "message.create", payload: { ...gatewayMessage(state, "analysis"), status: "streaming", exposure: "unknown" } });
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
      events.push({ protocolVersion: 2, type: "tool_call.create", payload: { status: "running", id, name: nonEmptyString(data.name) ?? "tool", args: asRecord(data.args) ?? {} } });
    } else if (phase === "update") {
      events.push({ protocolVersion: 2, type: "tool_call.delta", payload: { id, outputSnapshot: typeof (data.result ?? data.partialResult) === "string" ? String(data.result ?? data.partialResult) : JSON.stringify(data.result ?? data.partialResult ?? "") } });
    } else if (phase === "result") {
      events.push({ protocolVersion: 2, type: "tool_call.update", payload: { id, ...(nonEmptyString(data.name) ? { name: data.name } : {}), status: canonicalTerminalStatus(data.isError === true ? "error" : "completed"), output: data.result } });
    }
  } else if (stream === "item" && data.kind === "preamble" && typeof data.progressText === "string") {
    const nativeId = nonEmptyString(data.itemId);
    const message = gatewayMessage(state, "commentary", nativeId);
    events.push({ protocolVersion: 2, type: "message.update", payload: {
      ...message, text: data.progressText, status: data.phase === "end" ? "completed" : "streaming"
    } });
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
  return nonEmptyString(asRecord(asRecord(payload)?.data)?.error) ?? "OpenClaw Gateway agent run failed";
}

async function waitForConfirmedTerminal(
  client: OpenClawGatewayClientLike,
  runId: string,
  expected: "completed" | "failed" | "cancelled",
  deadlineAt: number
): Promise<void> {
  while (Date.now() < deadlineAt) {
    const waitMs = Math.max(1, Math.min(30_000, deadlineAt - Date.now()));
    const result = asRecord(await client.request("agent.wait", { runId, timeoutMs: waitMs }, { timeoutMs: waitMs + 2_000 }));
    const status = nonEmptyString(result?.status);
    const stopReason = nonEmptyString(result?.stopReason);
    const endedAt = finiteNumber(result?.endedAt);
    const cancelled = endedAt !== undefined && (stopReason === "aborted" || stopReason === "restart");
    const actual = cancelled
      ? "cancelled"
      : status === "ok"
        ? "completed"
        : status === "error" || (status === "timeout" && endedAt !== undefined)
          ? "failed"
          : undefined;
    if (actual === expected) return;
    if (!actual && (status === "pending" || status === "timeout")) {
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, Math.max(0, deadlineAt - Date.now()))));
      continue;
    }
    const error = nonEmptyString(result?.error);
    throw new Error(error
      ? `OpenClaw Gateway confirmed ${actual ?? status ?? "unknown"}, not ${expected}: ${error}`
      : `OpenClaw Gateway confirmed ${actual ?? status ?? "unknown"}, not ${expected}`);
  }
  throw new Error(`OpenClaw Gateway did not confirm ${expected} before the invocation deadline`);
}

function normalizeFinalResponse(value: unknown, state: StreamState): {
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
    .map(item => nonEmptyString(asRecord(item)?.text) ?? "")
    .filter(Boolean)
    .join("\n");
  const ensureStep = () => {
    if (state.stepStarted) return;
    state.stepStarted = true;
    events.push({ protocolVersion: 2, type: "model_step.started", payload: { stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}` } });
  };
  if (finalText) {
    ensureStep();
    const message = gatewayMessage(state, "final", state.assistantItemId);
    const change = snapshotDelta(state.assistantText, finalText);
    state.assistantText = finalText;
    if (change.delta) events.push({ protocolVersion: 2, type: "message.delta", payload: { ...message, text: change.delta, channel: "final" } });
    if (change.replacement !== undefined) {
      events.push({ protocolVersion: 2, type: "message.update", payload: { ...message, role: "assistant", status: "streaming", text: change.replacement, channel: "final" } });
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
  const terminal = status === "ok" ? (meta?.aborted === true ? "cancelled" : "completed") : status ? "failed" : undefined;
  if (terminal && !state.stepFinished) {
    ensureStep();
    state.stepFinished = true;
    events.push({ protocolVersion: 2,
      type: "model_step.finished",
      payload: {
        stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}`,
        status: canonicalTerminalStatus(terminal === "cancelled" ? "cancelled" : terminal === "failed" ? "failed" : "completed"),
        ...(nonEmptyString(meta?.stopReason) ? { finishReason: nonEmptyString(meta?.stopReason) } : {})
      }
    });
  }
  return {
    events,
    terminal,
    ...(terminal === "failed" ? { error: nonEmptyString(response?.summary) ?? "OpenClaw Gateway agent run failed" } : {})
  };
}

function assertRuntimeGatewayContract(value: unknown, externalBinding = false): void {
  const hello = asRecord(value);
  const features = asRecord(hello?.features);
  const methods = Array.isArray(features?.methods) ? features.methods : [];
  const events = Array.isArray(features?.events) ? features.events : [];
  if (hello?.protocol !== 4) throw new Error(`unsupported OpenClaw Gateway protocol: ${String(hello?.protocol)}`);
  const requiredMethods = ["sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"];
  if (!externalBinding) requiredMethods.unshift("config.get");
  else requiredMethods.unshift("agents.list");
  for (const method of requiredMethods) {
    if (!methods.includes(method)) throw new Error(`OpenClaw Gateway does not advertise required method ${method}`);
  }
  if (!events.includes("agent")) throw new Error("OpenClaw Gateway does not advertise the agent event stream");
}

function usesExistingAgent(req: InvokeRequest): boolean {
  // Work App's default assistant selects the user's existing main even when its Octo definition is provisioned.
  return req.agentSource === "preset" || req.agentConfig.providerAgentId === "main";
}

function assertRuntimeIsolationConfig(value: unknown, invocation: OpenClawGatewayInvocation): void {
  const snapshot = asRecord(value);
  const config = asRecord(snapshot?.config) ?? snapshot;
  const agents = asRecord(config?.agents);
  const defaults = asRecord(agents?.defaults);
  const entries = asRecord(agents?.entries);
  const agent = asRecord(entries?.[invocation.agentId]);
  const tools = asRecord(agent?.tools);
  const memory = asRecord(agent?.memory);
  const search = asRecord(memory?.search);
  const expectedWorkspace = invocation.runnerWorkspace;
  if (defaults?.skipBootstrap !== true) throw new Error("OpenClaw Gateway isolation drift: agents.defaults.skipBootstrap must be true");
  if (!agent) throw new Error(`OpenClaw Gateway isolation drift: agent ${invocation.agentId} is missing`);
  if (agent.contextInjection !== "never") throw new Error("OpenClaw Gateway isolation drift: contextInjection must be never");
  if (!Array.isArray(agent.skills) || agent.skills.length !== 0) throw new Error("OpenClaw Gateway isolation drift: skills must be empty");
  if (!Array.isArray(tools?.deny) || !tools.deny.includes("group:memory")) {
    throw new Error("OpenClaw Gateway isolation drift: memory tools must be denied");
  }
  if (!tools.deny.includes("ask_user")) {
    throw new Error("OpenClaw Gateway isolation drift: ask_user must be denied for unattended runs");
  }
  if (search?.rememberAcrossConversations !== false) {
    throw new Error("OpenClaw Gateway isolation drift: cross-conversation memory must be disabled");
  }
  if (expectedWorkspace && nonEmptyString(agent.workspace) !== expectedWorkspace) {
    throw new Error("OpenClaw Gateway isolation drift: runner workspace does not match the profile configuration");
  }
}

export interface OpenClawGatewayClientLike {
  connect(): Promise<unknown>;
  onEvent(listener: (event: OpenClawGatewayEvent) => void): () => void;
  request(method: string, params: JsonRecord, options?: {
    expectFinal?: boolean;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    onAccepted?: (value: unknown) => void;
  }): Promise<unknown>;
  close(): Promise<void>;
}

type GatewayClientFactory = (options: OpenClawGatewayOptions) => OpenClawGatewayClientLike;

async function* invokeOpenClawGateway(
  req: InvokeRequest,
  invocation: OpenClawGatewayInvocation,
  context: AdapterInvocationContext | undefined,
  clientFactory: GatewayClientFactory
): AsyncGenerator<CanonicalEvent> {
  const client = clientFactory(invocation.gateway);
  const queue = new EventQueue();
  let acceptedRunId = invocation.requestId;
  let agentAccepted = false;
  let providerSessionKey = invocation.sessionKey;
  const unsubscribe = client.onEvent(event => queue.push({ event }));
  const state: StreamState = { lastSeq: -1, assistantText: "", reasoningText: "", stepStarted: false, stepFinished: false, messageNumber: 0, messages: new Map(), tools: new Set() };
  let terminal: "completed" | "failed" | "cancelled" | undefined;

  try {
    const hello = await client.connect();
    const externalBinding = usesExistingAgent(req);
    assertRuntimeGatewayContract(hello, externalBinding);
    if (!externalBinding) {
      await client.request("config.get", {}, { timeoutMs: 10_000, signal: req.signal })
        .then(value => assertRuntimeIsolationConfig(value, invocation));
    } else await assertExistingAgent(client, invocation.agentId, req.signal);
    const created = asRecord(await client.request("sessions.create", invocation.createParams, {
      timeoutMs: 30_000,
      signal: req.signal
    }));
    providerSessionKey = nonEmptyString(created?.key) ?? invocation.sessionKey;
    invocation.agentParams.sessionKey = providerSessionKey;
    await client.request("sessions.messages.subscribe", {
      key: providerSessionKey,
      agentId: invocation.agentId
    }, { timeoutMs: 10_000, signal: req.signal });
    yield { protocolVersion: 2,
      type: "session.update",
      payload: { providerSession: { sessionId: providerSessionKey, resumable: false, agentId: invocation.agentId } }
    };

    const request = client.request("agent", invocation.agentParams, {
      expectFinal: true,
      timeoutMs: null,
      signal: req.signal,
      onAccepted: value => {
        agentAccepted = true;
        const runId = nonEmptyString(asRecord(value)?.runId);
        if (runId) acceptedRunId = runId;
        observeBestEffort(context, {
          event: "provider.dispatch.written",
          rpcMethod: "gateway.agent",
          providerSessionId: providerSessionKey,
          providerRequestId: acceptedRunId
        });
      }
    });
    void request.then(result => queue.push({ done: true, result }), error => queue.push({ error: error instanceof Error ? error : new Error(String(error)) }));

    while (!terminal) {
      const item = await queue.next();
      if (item.error) throw item.error;
      if (item.done) {
        const reconciled = normalizeFinalResponse(item.result, state);
        observeProviderOutput(context, reconciled.events, {
          rpcMethod: "gateway.agent.final",
          providerSessionId: providerSessionKey,
          providerRequestId: acceptedRunId,
          native: { type: "agent.final" }
        });
        for (const event of reconciled.events) yield event;
        terminal = reconciled.terminal;
        if (terminal === "failed") throw new Error(reconciled.error);
        break;
      }
      if (!item.event || item.event.event !== "agent") continue;
      const native = asRecord(item.event.payload);
      const runId = nonEmptyString(native?.runId);
      if (!runId || (runId !== acceptedRunId && runId !== invocation.requestId)) continue;
      const incomingSeq = finiteNumber(native?.seq);
      if (incomingSeq !== undefined && state.lastSeq >= 0 && incomingSeq > state.lastSeq + 1) {
        observeBestEffort(context, {
          event: "provider.output",
          rpcMethod: "gateway.event.agent",
          providerSessionId: providerSessionKey,
          providerRequestId: runId,
          data: {
            diagnostic: {
              type: "sequence_gap",
              expectedSeq: state.lastSeq + 1,
              receivedSeq: incomingSeq
            }
          }
        });
      }
      const events = normalizeGatewayAgentEvent(item.event.payload, state);
      observeProviderOutput(context, events, {
        rpcMethod: "gateway.event.agent",
        providerSessionId: providerSessionKey,
        providerRequestId: runId,
        native: { type: nonEmptyString(native?.stream) }
      });
      for (const event of events) yield event;
      terminal = terminalState(item.event.payload);
      if (terminal) {
        await waitForConfirmedTerminal(client, runId, terminal, invocation.reconciliationDeadlineAt);
        if (terminal === "failed") throw new Error(terminalError(item.event.payload));
      }
    }

    if (req.signal?.aborted || terminal === "cancelled") {
      yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
      yield { protocolVersion: 2, type: "run.cancelled", payload: { reason: String(req.signal?.reason ?? "openclaw_aborted") } };
      return;
    }
    if (terminal !== "completed") throw new Error("OpenClaw Gateway stream ended without a terminal lifecycle event");
    yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "completed", text: state.assistantText, channel: "final" } };
    yield { protocolVersion: 2, type: "run.completed", payload: {} };
  } catch (error) {
    if (req.signal?.aborted) {
      if (!agentAccepted) {
        yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
        yield { protocolVersion: 2, type: "run.cancelled", payload: { reason: String(req.signal.reason ?? "openclaw_aborted_before_dispatch") } };
        return;
      }
      let recoveryClient: OpenClawGatewayClientLike | undefined;
      try {
        const abortParams = { key: providerSessionKey, runId: acceptedRunId, agentId: invocation.agentId };
        let controlClient = client;
        try {
          await controlClient.request("sessions.abort", abortParams, { timeoutMs: 5_000 });
        } catch {
          recoveryClient = clientFactory(invocation.gateway);
          assertRuntimeGatewayContract(await recoveryClient.connect(), usesExistingAgent(req));
          controlClient = recoveryClient;
          await controlClient.request("sessions.abort", abortParams, { timeoutMs: 5_000 });
        }
        await waitForConfirmedTerminal(
          controlClient,
          acceptedRunId,
          "cancelled",
          Date.now() + 30_000
        );
        yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
        yield { protocolVersion: 2, type: "run.cancelled", payload: { reason: String(req.signal.reason ?? "openclaw_aborted") } };
      } catch (abortError) {
        const message = abortError instanceof Error ? abortError.message : "OpenClaw Gateway abort confirmation failed";
        yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "failed", text: state.assistantText, channel: "final" } };
        yield { protocolVersion: 2, type: "run.failed", payload: { message, adapterType: "openclaw" } };
      } finally {
        await recoveryClient?.close();
      }
      return;
    }
    let message = error instanceof Error ? error.message : String(error);
    if (agentAccepted && terminal !== "failed" && terminal !== "cancelled") {
      const recoveryClient = clientFactory(invocation.gateway);
      try {
        assertRuntimeGatewayContract(await recoveryClient.connect());
        await waitForConfirmedTerminal(recoveryClient, acceptedRunId, "completed", invocation.reconciliationDeadlineAt);
        yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "completed", text: state.assistantText, channel: "final" } };
        yield { protocolVersion: 2, type: "run.completed", payload: {} };
        return;
      } catch (recoveryError) {
        const detail = recoveryError instanceof Error ? recoveryError.message : "unknown reconciliation failure";
        message = `${message}; reconnect reconciliation failed: ${detail}`;
      } finally {
        await recoveryClient.close();
      }
    }
    observeBestEffort(context, {
      event: "provider.dispatch.failed",
      rpcMethod: "gateway.agent",
      providerSessionId: providerSessionKey,
      providerRequestId: acceptedRunId,
      data: { error: message }
    });
    yield { protocolVersion: 2, type: "message.update", payload: { ...gatewayMessage(state, "final", state.assistantItemId), role: "assistant", status: "failed", text: state.assistantText, channel: "final" } };
    yield { protocolVersion: 2, type: "run.failed", payload: { message, adapterType: "openclaw" } };
  } finally {
    unsubscribe();
    await client.close();
  }
}

export function createOpenClawAdapter(
  { clientFactory = options => new OpenClawGatewayClient(options) }: { clientFactory?: GatewayClientFactory } = {}
) {
  let pendingProbe: Promise<{ available: boolean; command: string; reason?: string }> | undefined;
  const probeGateway = async () => {
    let client: OpenClawGatewayClientLike | undefined;
    try {
      client = clientFactory(await loadLocalOpenClawGateway());
      assertRuntimeGatewayContract(await client.connect(), true);
      await assertExistingAgent(client, "main");
      return { available: true, command: "openclaw-gateway" };
    } catch (error) { return { available: false, command: "openclaw-gateway", reason: localGatewayFailure(error) }; }
    finally { await client?.close(); }
  };
  return defineAdapter({
    metadata: {
      type: "openclaw",
      processModel: "websocket-per-invocation",
      transport: "openclaw-gateway-rpc",
      capabilities: ["react"],
      agentSources: ["preset", "provisioned"],
      executionFeatures: ["tool.canonical", "agent.existing-target.v1"]
    },
    probe() {
      return pendingProbe ??= probeGateway().finally(() => { pendingProbe = undefined; });
    },
    async *invoke(req: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      if (!option(req, OPENCLAW_PROVIDER_OPTIONS.url)) {
        const gateway = await loadLocalOpenClawGateway();
        req = { ...req, agentConfig: { ...req.agentConfig, providerOptions: {
          [OPENCLAW_PROVIDER_OPTIONS.url]: gateway.url,
          [OPENCLAW_PROVIDER_OPTIONS.token]: gateway.token,
          [OPENCLAW_PROVIDER_OPTIONS.deviceId]: gateway.device.deviceId,
          [OPENCLAW_PROVIDER_OPTIONS.publicKey]: gateway.device.publicKey,
          [OPENCLAW_PROVIDER_OPTIONS.privateKey]: gateway.device.privateKey
        } } };
      }
      if (req.agentSource === "preset" && req.workdir) throw new Error("CONTEXT_WORKSPACE_UNSUPPORTED: preset OpenClaw uses its provider workspace");
      const invocation = buildOpenClawGatewayInvocation(req);
      await context?.observe({
        event: "provider.input",
        rpcMethod: "gateway.agents.list+sessions.create+messages.subscribe+agent",
        providerSessionId: invocation.sessionKey,
        providerRequestId: invocation.requestId,
        carrier: invocation.providerInput
      });
      yield* invokeOpenClawGateway(req, invocation, context, clientFactory);
    }
  });
}

async function assertExistingAgent(client: OpenClawGatewayClientLike, agentId: string, signal?: AbortSignal): Promise<void> {
  const result = asRecord(await client.request("agents.list", {}, { timeoutMs: 1_000, signal }));
  const agents = Array.isArray(result?.agents) ? result.agents : [];
  if (!agents.some(agent => asRecord(agent)?.id === agentId)) throw new Error(`OpenClaw agent ${agentId} is missing`);
}

export { loadLocalOpenClawGateway } from "./local-gateway.js";

export {
  OpenClawGatewayClient,
  createOpenClawDeviceIdentity,
  type OpenClawDeviceIdentity,
  type OpenClawGatewayEvent,
  type OpenClawGatewayOptions
} from "./gateway.js";
export {
  normalizeOpenClawFrame,
  OpenClawTranscriptNormalizer,
  tryParseOpenClawEvent,
  tryParseOpenClawFinalBlob,
  tryParseOpenClawTranscriptLine
} from "./parser.js";

export const openclawAdapter = createOpenClawAdapter();
export default openclawAdapter;
