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

type JsonRecord = Record<string, unknown>;

export const OPENCLAW_PROVIDER_OPTIONS = {
  url: "OPENCLAW_GATEWAY_URL",
  token: "OPENCLAW_GATEWAY_TOKEN",
  deviceId: "OPENCLAW_GATEWAY_DEVICE_ID",
  publicKey: "OPENCLAW_GATEWAY_PUBLIC_KEY",
  privateKey: "OPENCLAW_GATEWAY_PRIVATE_KEY",
  agentId: "OPENCLAW_AGENT_ID",
  workspace: "OPENCLAW_RUNNER_WORKSPACE"
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
  const configuredAgent = option(req, OPENCLAW_PROVIDER_OPTIONS.agentId);
  const agentId = req.agentConfig.providerAgentId ?? configuredAgent ?? "octo-openclaw-runner";
  const runnerWorkspace = option(req, OPENCLAW_PROVIDER_OPTIONS.workspace);
  const sessionKey = `agent:${agentId}:octo-run:${req.runId}:${randomUUID()}`;
  const requestId = `octo-harness-${req.runId}-${randomUUID()}`;
  const message = composeOpenClawPrompt(req);
  const timeout = finiteNumber(req.agentConfig.timeoutSeconds);
  const model = nonEmptyString(req.agentConfig.model);
  const thinking = nonEmptyString(req.agentConfig.thinking);
  const timeoutMilliseconds = timeout && timeout > 0 ? timeout * 1_000 : 30 * 60_000;
  const reconciliationGraceMilliseconds = Math.min(30_000, timeoutMilliseconds * 0.1);
  const createParams: JsonRecord = {
    key: sessionKey,
    agentId,
    cwd: req.workdir,
    idempotencyKey: `${requestId}-session`,
    ...(model ? { model } : {}),
    ...(thinking ? { thinkingLevel: thinking } : {})
  };
  const agentParams: JsonRecord = {
    message,
    agentId,
    sessionKey,
    deliver: false,
    promptMode: "minimal",
    idempotencyKey: requestId,
    ...(req.appendInstructions ? { extraSystemPrompt: req.appendInstructions } : {}),
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
          { method: "config.get", params: {} },
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
  return {
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
    events.push({ type: "model_step.started", payload: { stepId } });
  };

  if (stream === "lifecycle") {
    const phase = nonEmptyString(data.phase);
    if (phase === "start") ensureStep();
    if ((phase === "end" || phase === "error") && state.stepStarted && !state.stepFinished) {
      state.stepFinished = true;
      const finishReason = nonEmptyString(data.stopReason);
      events.push({
        type: "model_step.finished",
        payload: {
          stepId,
          status: phase === "error" ? "failed" : data.aborted === true ? "cancelled" : "completed",
          ...(finishReason ? { finishReason } : {})
        }
      });
    }
    return events;
  }

  ensureStep();
  if (stream === "assistant" && typeof data.text === "string") {
    const change = snapshotDelta(state.assistantText, data.text);
    state.assistantText = data.text;
    if (change.delta) events.push({ type: "message.delta", payload: { text: change.delta, channel: "final" } });
    if (change.replacement !== undefined) {
      events.push({ type: "message.update", payload: { role: "assistant", status: "streaming", text: change.replacement, channel: "final" } });
    }
  } else if (stream === "thinking" && typeof data.text === "string") {
    const change = snapshotDelta(state.reasoningText, data.text);
    state.reasoningText = data.text;
    const text = change.delta ?? change.replacement;
    if (text) {
      events.push({
        type: change.replacement === undefined ? "message.delta" : "message.update",
        payload: {
          role: "assistant",
          status: "streaming",
          text,
          channel: "analysis",
          exposure: "public_reasoning",
          provenance: { provider: "openclaw", nativeEvent: "gateway.agent.thinking" }
        }
      });
    }
  } else if (stream === "tool") {
    const phase = nonEmptyString(data.phase);
    const id = nonEmptyString(data.toolCallId) ?? "tool";
    if (phase === "start") {
      events.push({ type: "tool_call.create", payload: { id, name: nonEmptyString(data.name) ?? "tool", args: asRecord(data.args) ?? {} } });
    } else if (phase === "update") {
      events.push({ type: "tool_call.update", payload: { id, status: "running", output: data.result ?? data.partialResult } });
    } else if (phase === "result") {
      events.push({ type: "tool_call.update", payload: { id, status: data.isError === true ? "error" : "completed", output: data.result } });
    }
  } else if (stream === "item" && data.kind === "preamble" && typeof data.progressText === "string") {
    events.push({
      type: "message.delta",
      payload: {
        text: data.progressText,
        channel: "analysis",
        exposure: "public_summary",
        provenance: { provider: "openclaw", nativeEvent: "gateway.agent.item" }
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
    events.push({ type: "model_step.started", payload: { stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}` } });
  };
  if (finalText) {
    ensureStep();
    const change = snapshotDelta(state.assistantText, finalText);
    state.assistantText = finalText;
    if (change.delta) events.push({ type: "message.delta", payload: { text: change.delta, channel: "final" } });
    if (change.replacement !== undefined) {
      events.push({ type: "message.update", payload: { role: "assistant", status: "streaming", text: change.replacement, channel: "final" } });
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
    events.push({
      type: "model_step.finished",
      payload: {
        stepId: `openclaw:${nonEmptyString(response?.runId) ?? "run"}`,
        status: terminal === "cancelled" ? "cancelled" : terminal === "failed" ? "failed" : "completed",
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

function assertRuntimeGatewayContract(value: unknown): void {
  const hello = asRecord(value);
  const features = asRecord(hello?.features);
  const methods = Array.isArray(features?.methods) ? features.methods : [];
  const events = Array.isArray(features?.events) ? features.events : [];
  if (hello?.protocol !== 4) throw new Error(`unsupported OpenClaw Gateway protocol: ${String(hello?.protocol)}`);
  for (const method of ["config.get", "sessions.create", "sessions.messages.subscribe", "agent", "agent.wait", "sessions.abort"]) {
    if (!methods.includes(method)) throw new Error(`OpenClaw Gateway does not advertise required method ${method}`);
  }
  if (!events.includes("agent")) throw new Error("OpenClaw Gateway does not advertise the agent event stream");
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
  const state: StreamState = { lastSeq: -1, assistantText: "", reasoningText: "", stepStarted: false, stepFinished: false };
  let terminal: "completed" | "failed" | "cancelled" | undefined;

  try {
    const hello = await client.connect();
    assertRuntimeGatewayContract(hello);
    await client.request("config.get", {}, { timeoutMs: 10_000, signal: req.signal })
      .then(value => assertRuntimeIsolationConfig(value, invocation));
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
    yield {
      type: "session.update",
      payload: { providerSession: { sessionId: providerSessionKey, resumable: false, agentId: invocation.agentId } }
    };
    yield { type: "message.create", payload: { role: "assistant", status: "streaming", channel: "final" } };

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
      yield { type: "message.update", payload: { role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
      yield { type: "run.stopped", payload: { reason: String(req.signal?.reason ?? "openclaw_aborted") } };
      return;
    }
    if (terminal !== "completed") throw new Error("OpenClaw Gateway stream ended without a terminal lifecycle event");
    yield { type: "message.update", payload: { role: "assistant", status: "completed", text: state.assistantText, channel: "final" } };
    yield { type: "run.finished", payload: {} };
  } catch (error) {
    if (req.signal?.aborted) {
      if (!agentAccepted) {
        yield { type: "message.update", payload: { role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
        yield { type: "run.stopped", payload: { reason: String(req.signal.reason ?? "openclaw_aborted_before_dispatch") } };
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
        yield { type: "message.update", payload: { role: "assistant", status: "stopped", text: state.assistantText, channel: "final" } };
        yield { type: "run.stopped", payload: { reason: String(req.signal.reason ?? "openclaw_aborted") } };
      } catch (abortError) {
        const message = abortError instanceof Error ? abortError.message : "OpenClaw Gateway abort confirmation failed";
        yield { type: "message.update", payload: { role: "assistant", status: "failed", text: state.assistantText, channel: "final" } };
        yield { type: "run.error", payload: { message, adapterType: "openclaw" } };
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
        yield { type: "message.update", payload: { role: "assistant", status: "completed", text: state.assistantText, channel: "final" } };
        yield { type: "run.finished", payload: {} };
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
    yield { type: "message.update", payload: { role: "assistant", status: "failed", text: state.assistantText, channel: "final" } };
    yield { type: "run.error", payload: { message, adapterType: "openclaw" } };
  } finally {
    unsubscribe();
    await client.close();
  }
}

export function createOpenClawAdapter(
  { clientFactory = options => new OpenClawGatewayClient(options) }: { clientFactory?: GatewayClientFactory } = {}
) {
  return defineAdapter({
    metadata: {
      type: "openclaw",
      processModel: "websocket-per-invocation",
      transport: "openclaw-gateway-rpc",
      capabilities: ["tool.canonical"]
    },
    probe: () => Promise.resolve({ available: true, command: "openclaw-gateway" }),
    async *invoke(req: InvokeRequest, context?: AdapterInvocationContext): AsyncGenerator<CanonicalEvent> {
      const invocation = buildOpenClawGatewayInvocation(req);
      await context?.observe({
        event: "provider.input",
        rpcMethod: "gateway.config.get+sessions.create+messages.subscribe+agent",
        providerSessionId: invocation.sessionKey,
        providerRequestId: invocation.requestId,
        carrier: invocation.providerInput
      });
      yield* invokeOpenClawGateway(req, invocation, context, clientFactory);
    }
  });
}

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
