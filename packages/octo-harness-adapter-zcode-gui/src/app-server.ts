import { canonicalTerminalStatus } from "@mininglamp-oss/octo-harness-protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type AcpApprovalBridge,
  freshFallbackInputText,
  observeBestEffort,
  observeProviderOutput,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-adapter-sdk";

const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 500;
const KILL_GRACE_MS = 1_000;
const STDERR_TAIL_LIMIT = 64 * 1_024;
const MAX_PUBLIC_TEXT_CHARS = 1_000;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface QueueWaiter<T> {
  resolve: (value: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}

export interface ZcodeSessionEvent {
  sessionId: string;
  seq?: number;
  type: string;
  payload?: JsonRecord;
}

export interface ZcodeAppServerCommand {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup?: () => void | Promise<void>;
}

export type ZcodeAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
) => ChildProcessWithoutNullStreams;

export class ZcodeAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: string | number,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method}: ${message}`);
    this.name = "ZcodeAppServerRpcError";
  }
}

export class ZcodeAppServerProcessError extends Error {
  constructor(message: string, readonly exit: ProcessExit) {
    super(message);
    this.name = "ZcodeAppServerProcessError";
  }
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<QueueWaiter<T>> = [];
  #closed = false;
  #error?: Error;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (!this.#closed) this.#items.push(value);
  }

  end(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

export interface NormalizerState {
  stepId: string;
  stepStarted: boolean;
  stepFinished: boolean;
  finalMessageStarted: boolean;
  reasoningMessageStarted: boolean;
  publicText: string;
  tools: Map<string, { name: string; input: unknown; terminal: boolean; created: boolean }>;
}

export class ZcodeEventNormalizer {
  readonly #state: NormalizerState;

  constructor(runId: string) {
    this.#state = {
      stepId: `zcode-gui:${runId}`,
      stepStarted: false,
      stepFinished: false,
      finalMessageStarted: false,
      reasoningMessageStarted: false,
      publicText: "",
      tools: new Map()
    };
  }

  normalize(event: ZcodeSessionEvent): CanonicalEvent[] {
    return normalizeZcodeEvent(event, this.#state);
  }
}

export function normalizeZcodeEvent(event: ZcodeSessionEvent, state: NormalizerState): CanonicalEvent[] {
  const payload = asRecord(event.payload) ?? {};
  const events: CanonicalEvent[] = [];
  const ensureStep = (): void => {
    if (state.stepStarted) return;
    state.stepStarted = true;
    events.push({ protocolVersion: 2, type: "model_step.started", payload: { stepId: state.stepId } });
  };

  if (event.type === "turn.started") {
    ensureStep();
    return events;
  }

  if (event.type === "model.streaming") {
    ensureStep();
    const kind = stringField(payload, "kind");
    if (kind === "text_delta") {
      const text = stringField(payload, "delta");
      if (!text) return events;
      if (!state.finalMessageStarted) {
        state.finalMessageStarted = true;
        events.push({ protocolVersion: 2,
          type: "message.create",
          payload: { messageId: `${state.stepId}:final`, role: "assistant", status: "streaming", channel: "final", stepId: state.stepId }
        });
      }
      appendPublicText(state, text);
      events.push({ protocolVersion: 2,
        type: "message.delta",
        payload: { messageId: `${state.stepId}:final`, text, channel: "final", stepId: state.stepId }
      });
      return events;
    }
    if (kind === "reasoning_delta") {
      const text = stringField(payload, "delta");
      if (!text) return events;
      if (!state.reasoningMessageStarted) {
        state.reasoningMessageStarted = true;
        events.push({ protocolVersion: 2,
          type: "message.create",
          payload: {
            messageId: `${state.stepId}:reasoning`,
            role: "assistant",
            status: "streaming",
            channel: "analysis",
            exposure: "public_reasoning",
            stepId: state.stepId
          }
        });
      }
      events.push({ protocolVersion: 2,
        type: "message.delta",
        payload: {
          messageId: `${state.stepId}:reasoning`,
          text,
          channel: "analysis",
          exposure: "public_reasoning",
          stepId: state.stepId,
          provenance: { provider: "zcode-gui", nativeEvent: event.type }
        }
      });
      return events;
    }
    if (kind === "tool_call") {
      const id = stringField(payload, "toolCallId");
      if (id && !state.tools.has(id)) {
        state.tools.set(id, {
          name: stringField(payload, "toolName") ?? "zcode_tool",
          input: payload.input,
          terminal: false,
          created: false
        });
      }
    }
    return events;
  }

  if (event.type === "tool.updated") {
    ensureStep();
    const kind = stringField(payload, "kind") ?? "progress";
    if (kind === "batch") {
      const ids = Array.isArray(payload.toolCallIds) ? payload.toolCallIds.filter(isString) : [];
      const status = numberField(payload, "errorCount") && numberField(payload, "errorCount")! > 0 ? "failed" : "completed";
      for (const id of ids) {
        const tool = state.tools.get(id);
        if (!tool || tool.terminal) continue;
        tool.terminal = true;
        events.push({ protocolVersion: 2, type: "tool_call.update", payload: { id, name: tool.name, args: tool.input, status: canonicalTerminalStatus(status), stepId: state.stepId } });
      }
      return events;
    }

    const id = stringField(payload, "toolCallId");
    if (!id) return events;
    let tool = state.tools.get(id);
    if (!tool) {
      tool = {
        name: stringField(payload, "toolName") ?? "zcode_tool",
        input: payload.input,
        terminal: false,
        created: false
      };
      state.tools.set(id, tool);
    } else {
      tool.name = stringField(payload, "toolName") ?? tool.name;
      if (payload.input !== undefined) tool.input = payload.input;
    }
    if (tool.terminal) return events;
    if (kind !== "result" && kind !== "error" && (kind === "scheduled" || !toolCreated(events, state, id))) {
      const created = ensureToolCreated(state, id);
      if (created) events.push(created);
    }
    if (kind === "scheduled") return events;
    if (kind === "started") {
      return events;
    }
    if (kind === "progress") {
      events.push({ protocolVersion: 2,
        type: "tool_call.delta",
        payload: {
          id,
          outputSnapshot: printableValue(payload.stdoutTail ?? payload.stderrTail, ""),
          stepId: state.stepId
        }
      });
      return events;
    }
    if (kind === "result") {
      tool.terminal = true;
      events.push({ protocolVersion: 2, type: "tool_call.update", payload: { id, name: tool.name, args: tool.input, status: canonicalTerminalStatus("completed"), output: payload.result, stepId: state.stepId } });
      return events;
    }
    if (kind === "error") {
      tool.terminal = true;
      events.push({ protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id,
          name: tool.name,
          args: tool.input,
          status: canonicalTerminalStatus("failed"),
          error: asRecord(payload.error) ?? { message: printableValue(payload.error, "ZCode tool failed") },
          stepId: state.stepId
        }
      });
    }
    return events;
  }

  if (event.type === "session.updated") {
    const usage = asRecord(payload.usage);
    if (usage) events.push({ protocolVersion: 2, type: "usage.update", payload: { ...usage, ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {}) } });
    return events;
  }

  if (event.type === "turn.completed" || event.type === "turn.failed") {
    const failed = event.type === "turn.failed";
    const resultType = stringField(payload, "resultType") ?? (failed ? "error" : "success");
    const cancelled = /cancel|abort|stop|interrupt/i.test(resultType);
    const usage = asRecord(payload.usage);
    if (usage) events.push({ protocolVersion: 2, type: "usage.update", payload: { ...usage } });
    if (state.stepStarted && !state.stepFinished) {
      state.stepFinished = true;
      events.push({ protocolVersion: 2,
        type: "model_step.finished",
        payload: {
          stepId: state.stepId,
          status: canonicalTerminalStatus(failed ? "failed" : cancelled ? "cancelled" : "completed"),
          finishReason: resultType,
        }
      });
    }
    if (state.reasoningMessageStarted) {
      events.push({ protocolVersion: 2,
        type: "message.update",
        payload: { messageId: `${state.stepId}:reasoning`, role: "assistant", status: failed ? "failed" : cancelled ? "stopped" : "completed" }
      });
    }
    if (state.finalMessageStarted) {
      events.push({ protocolVersion: 2,
        type: "message.update",
        payload: { messageId: `${state.stepId}:final`, role: "assistant", status: failed ? "failed" : cancelled ? "stopped" : "completed" }
      });
    }
    if (failed) {
      const error = asRecord(payload.error);
      events.push({ protocolVersion: 2,
        type: "run.failed",
        payload: {
          adapterType: "zcode-gui",
          code: error?.code ?? "ZCODE_TURN_FAILED",
          message: stringField(error, "message") ?? "ZCode turn failed"
        }
      });
    } else if (cancelled) {
      events.push({ protocolVersion: 2, type: "run.cancelled", payload: { reason: resultType } });
    } else {
      events.push({ protocolVersion: 2, type: "run.completed", payload: {} });
    }
  }
  return events;
}

export async function* runZcodeAppServerTurn({
  request,
  spec,
  context,
  spawnFn = defaultSpawn,
  approvalBridge
}: {
  request: InvokeRequest;
  spec: ZcodeAppServerCommand;
  context?: AdapterInvocationContext;
  spawnFn?: ZcodeAppServerSpawn;
  approvalBridge?: AcpApprovalBridge;
}): AsyncGenerator<CanonicalEvent> {
  if (request.approvalMode === "assisted" || (request.approvalMode === "ask" && !approvalBridge)) throw new Error("APPROVAL_MODE_UNSUPPORTED");
  if (request.agentConfig.model) throw new Error("EXECUTION_SELECTION_UNSUPPORTED: zcode independent model selection is not qualified");
  const autoApprove = request.approvalMode === "full_access";
  const client = new ZcodeAppServerClient({
    spec,
    spawnFn,
    requestTimeoutMs: requestTimeout(request),
    autoApprove,
    permissionHandler: approvalBridge ? async (params, write) => {
      const permission = {
        toolCall: { title: typeof params.reason === "string" ? params.reason : "ZCode tool permission" },
        options: [{ kind: "allow_once", optionId: "allow" }, { kind: "reject_once", optionId: "deny" }]
      };
      try {
        const result = await approvalBridge.requestPermission(permission);
        await write({ decision: (result.outcome as { optionId?: string })?.optionId === "allow" ? "allow" : "deny" });
        approvalBridge.responseWritten(permission);
      } catch (error) {
        approvalBridge.responseFailed(permission, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    } : undefined
  });
  approvalBridge?.bindTransport(() => client.close());
  let sessionId: string | undefined;
  let terminal = false;
  let promptRequestId: string | undefined;
  const abort = (): void => {
    if (sessionId) client.notify("session/stop", { sessionId });
    const timer = setTimeout(() => { void client.close(); }, CLOSE_GRACE_MS);
    timer.unref();
  };
  if (request.signal?.aborted) abort();
  else request.signal?.addEventListener("abort", abort, { once: true });

  try {
    throwIfAborted(request.signal);
    const requestedSessionId = request.providerSession?.sessionId;
    let resumed = false;
    let resumeFallback: string | undefined;
    const workspace = { workspacePath: request.workdir, workspaceKey: request.workdir };
    let sessionResult: unknown;

    if (requestedSessionId) {
      try {
        sessionResult = await observedRequest(client, context, "session/resume", {
          sessionId: requestedSessionId,
          workspace
        }, requestedSessionId);
        sessionId = extractSessionId(sessionResult) ?? requestedSessionId;
        resumed = true;
      } catch (error) {
        resumeFallback = failureReason(error);
      }
    }

    if (!sessionId) {
      const mode = zcodeMode(request);
      sessionResult = await observedRequest(client, context, "session/create", { workspace, mode });
      sessionId = extractSessionId(sessionResult);
      if (!sessionId) throw new Error("ZCode session/create returned no session id");
    }

    client.setActiveSession(sessionId);
    await observedRequest(client, context, "session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
      afterSeq: 0
    }, sessionId);

    const input = resumeFallback ? freshFallbackInputText(request) : providerInputText(request);
    const content = request.controlInstructions ? `${input}\n\n${request.controlInstructions}` : input;
    const sendResult = await observedRequest(
      client,
      context,
      "session/send",
      { sessionId, content },
      sessionId,
      id => { promptRequestId = id; }
    );
    if (asRecord(sendResult)?.accepted === false) throw new Error("ZCode session/send was not accepted");

    yield { protocolVersion: 2,
      type: "session.update",
      payload: {
        providerSession: {
          sessionId,
          resumable: true,
          ...(resumed ? { resumeOutcome: "resumed" } : {}),
          ...(resumeFallback ? {
            resumeOutcome: "fresh_fallback",
            resumeFallback,
            contextInputVariant: request.freshFallbackModelInput ? "recovery" : "primary"
          } : {})
        }
      }
    };

    const normalizer = new ZcodeEventNormalizer(request.runId);
    let firstOutput = true;
    for await (const nativeEvent of client.events()) {
      const events = normalizer.normalize(nativeEvent);
      if (events.length === 0) continue;
      if (firstOutput) {
        firstOutput = false;
        observeBestEffort(context, {
          event: "provider.output.first",
          rpcMethod: "session/event",
          providerSessionId: sessionId,
          ...(promptRequestId ? { providerRequestId: promptRequestId } : {})
        });
      }
      observeProviderOutput(context, events, {
        rpcMethod: "session/event",
        providerSessionId: sessionId,
        ...(promptRequestId ? { providerRequestId: promptRequestId } : {}),
        native: { type: nativeEvent.type, provider: "zcode-gui" }
      });
      for (const event of events) {
        terminal ||= isTerminal(event);
        yield event;
      }
      if (terminal) break;
    }

    if (!terminal) {
      const exit = await client.exit();
      throw new ZcodeAppServerProcessError(client.processErrorMessage(exit), exit);
    }
  } catch (error) {
    if (!terminal) {
      if (request.signal?.aborted) {
        yield { protocolVersion: 2, type: "run.cancelled", payload: { reason: String(request.signal.reason ?? "cancelled") } };
      } else {
        yield { protocolVersion: 2,
          type: "run.failed",
          payload: {
            adapterType: "zcode-gui",
            code: errorCode(error),
            message: client.errorMessage(error)
          }
        };
      }
    }
  } finally {
    request.signal?.removeEventListener("abort", abort);
    await client.close();
    await spec.cleanup?.();
  }
}

class ZcodeAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #events = new AsyncQueue<ZcodeSessionEvent>();
  readonly #requestTimeoutMs: number;
  readonly #autoApprove: boolean;
  readonly #permissionHandler?: (params: JsonRecord, write: (result: JsonRecord) => Promise<void>) => Promise<void>;
  readonly #exitPromise: Promise<ProcessExit>;
  #resolveExit!: (exit: ProcessExit) => void;
  #nextId = 1;
  #stderr = "";
  #activeSession?: string;
  #lastSeq = 0;
  #closed = false;

  constructor({
    spec,
    spawnFn,
    requestTimeoutMs,
    autoApprove,
    permissionHandler
  }: {
    spec: ZcodeAppServerCommand;
    spawnFn: ZcodeAppServerSpawn;
    requestTimeoutMs: number;
    autoApprove: boolean;
    permissionHandler?: (params: JsonRecord, write: (result: JsonRecord) => Promise<void>) => Promise<void>;
  }) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#autoApprove = autoApprove;
    this.#permissionHandler = permissionHandler;
    this.#exitPromise = new Promise(resolve => { this.#resolveExit = resolve; });
    this.#child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32"
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (value: string | Buffer) => {
      this.#stderr = (this.#stderr + value.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    this.#child.stdin.on("error", error => this.#failAll(error));
    createInterface({ input: this.#child.stdout }).on("line", line => this.#receiveLine(line));
    this.#child.once("error", error => {
      this.#resolveExit({ code: null, signal: null });
      this.#failAll(error);
    });
    this.#child.once("exit", (code, signal) => {
      const exit = { code, signal };
      this.#resolveExit(exit);
      if (!this.#closed) this.#failAll(new ZcodeAppServerProcessError(this.processErrorMessage(exit), exit));
    });
  }

  reserveRequestId(): number {
    return this.#nextId++;
  }

  setActiveSession(sessionId: string): void {
    this.#activeSession = sessionId;
  }

  request(method: string, params: JsonRecord, onWritten?: () => void, requestId?: RpcId): Promise<unknown> {
    const id = requestId ?? this.reserveRequestId();
    let timer: NodeJS.Timeout;
    const result = new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`ZCode ${method} timed out after ${this.#requestTimeoutMs}ms`));
      }, this.#requestTimeoutMs);
      timer.unref();
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    this.#write({ id, method, params }, onWritten);
    return result;
  }

  notify(method: string, params: JsonRecord = {}): void {
    this.#write({ method, params });
  }

  events(): AsyncIterableIterator<ZcodeSessionEvent> {
    return this.#events;
  }

  exit(): Promise<ProcessExit> {
    return this.#exitPromise;
  }

  errorMessage(error: unknown): string {
    const base = error instanceof Error ? error.message : String(error);
    const stderr = this.#stderr.trim();
    return stderr && !base.includes(stderr) ? `${base}: ${stderr}` : base;
  }

  processErrorMessage(exit: ProcessExit): string {
    return this.#stderr.trim() || `ZCode app-server exited before a terminal event: ${exit.code ?? exit.signal ?? "unknown"}`;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("ZCode app-server client closed"));
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    signalProcessTree(this.#child, "SIGTERM");
    await Promise.race([this.#exitPromise, delay(KILL_GRACE_MS)]);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      signalProcessTree(this.#child, "SIGKILL");
      await Promise.race([this.#exitPromise, delay(KILL_GRACE_MS)]);
    }
  }

  #receiveLine(line: string): void {
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(line)) ?? {};
    } catch {
      return;
    }
    const id = rpcId(message.id);
    const method = stringField(message, "method");
    if (id !== undefined && (method === undefined || this.#pending.has(id))) {
      const pending = this.#pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      const error = asRecord(message.error);
      if (error) {
        pending.reject(new ZcodeAppServerRpcError(
          pending.method,
          typeof error.code === "string" || typeof error.code === "number" ? error.code : "ZCODE_RPC_ERROR",
          stringField(error, "message") ?? "ZCode RPC failed",
          error.detail
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (id !== undefined && method !== undefined) {
      this.#handleServerRequest(id, method, asRecord(message.params) ?? {});
      return;
    }
    if (method !== "session/event") return;
    const params = asRecord(message.params);
    const sessionId = stringField(params, "sessionId");
    const type = stringField(params, "type");
    const seq = numberField(params, "seq");
    if (!sessionId || !type || sessionId !== this.#activeSession) return;
    if (seq !== undefined && seq <= this.#lastSeq) return;
    if (seq !== undefined) this.#lastSeq = seq;
    this.#events.push({ sessionId, type, ...(seq !== undefined ? { seq } : {}), payload: asRecord(params?.payload) });
  }

  #handleServerRequest(id: RpcId, method: string, params: JsonRecord): void {
    if (method === "session/requestRuntimePreferences") {
      this.#reply(id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
        askUserQuestionAutoResolutionEnabled: false
      });
      return;
    }
    if (method === "interaction/requestPermission") {
      if (this.#permissionHandler) {
        void this.#permissionHandler(params, result => new Promise<void>((resolve, reject) => {
          this.#child.stdin.write(`${JSON.stringify({ id, result })}\n`, error => error ? reject(error) : resolve());
        })).catch(error => this.#failAll(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      this.#reply(id, this.#autoApprove
        ? { decision: "allow" }
        : { decision: "deny", reason: "Octo Harness unattended policy denied this tool request" });
      return;
    }
    if (method === "interaction/requestUserInput") {
      const planApproval = asRecord(params.schema)?.interaction === "plan_approval";
      this.#reply(id, this.#autoApprove && planApproval
        ? { action: "accept", content: { answer_0: "approve" } }
        : { action: "decline", reason: "Octo Harness has no interactive input channel for ZCode" });
      return;
    }
    this.#write({ id, error: { code: -32601, message: `unsupported ZCode client request: ${method}` } });
  }

  #reply(id: RpcId, result: unknown): void {
    this.#write({ id, result });
  }

  #write(message: JsonRecord, onWritten?: () => void): void {
    if (this.#child.stdin.destroyed) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, error => {
      if (!error) onWritten?.();
    });
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#events.end(error);
  }
}

async function observedRequest(
  client: ZcodeAppServerClient,
  context: AdapterInvocationContext | undefined,
  method: string,
  params: JsonRecord,
  providerSessionId?: string,
  onRequestId?: (id: string) => void
): Promise<unknown> {
  const requestId = client.reserveRequestId();
  const providerRequestId = String(requestId);
  onRequestId?.(providerRequestId);
  await context?.observe({
    event: "provider.input",
    rpcMethod: method,
    providerRequestId,
    ...(providerSessionId ? { providerSessionId } : {}),
    carrier: { kind: "json_params", content: { method, params } }
  });
  try {
    const result = await client.request(method, params, () => {
      observeBestEffort(context, {
        event: "provider.dispatch.written",
        rpcMethod: method,
        providerRequestId,
        ...(providerSessionId ? { providerSessionId } : {})
      });
    }, requestId);
    observeBestEffort(context, {
      event: "provider.dispatch.acknowledged",
      rpcMethod: method,
      providerRequestId,
      ...(providerSessionId ? { providerSessionId } : {})
    });
    return result;
  } catch (error) {
    observeBestEffort(context, {
      event: "provider.dispatch.failed",
      rpcMethod: method,
      providerRequestId,
      ...(providerSessionId ? { providerSessionId } : {}),
      data: { error: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
}

function ensureToolCreated(state: NormalizerState, id: string): CanonicalEvent | undefined {
  const tool = state.tools.get(id);
  if (!tool || tool.created) return undefined;
  tool.created = true;
  return { protocolVersion: 2,
    type: "tool_call.create",
    payload: {
      id,
      name: tool.name,
      args: asRecord(tool.input) ?? (tool.input === undefined ? {} : { value: tool.input }),
      status: "running",
      stepId: state.stepId
    }
  };
}

function toolCreated(events: CanonicalEvent[], state: NormalizerState, id: string): boolean {
  return events.some(event => event.type === "tool_call.create" && event.payload.id === id)
    || state.tools.get(id)?.created === true;
}

function appendPublicText(state: NormalizerState, value: string): void {
  const remaining = MAX_PUBLIC_TEXT_CHARS - Array.from(state.publicText).length;
  if (remaining > 0) state.publicText += Array.from(value).slice(0, remaining).join("");
}

function extractSessionId(value: unknown): string | undefined {
  const result = asRecord(value);
  return stringField(asRecord(result?.session), "sessionId") ?? stringField(result, "sessionId");
}

function zcodeMode(request: InvokeRequest): string {
  return request.approvalMode === "full_access" ? "yolo" : "build";
}

function requestTimeout(request: InvokeRequest): number {
  const configured = request.agentConfig.providerOptions?.appServerRequestTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : REQUEST_TIMEOUT_MS;
}

function failureReason(error: unknown): string {
  if (error instanceof ZcodeAppServerRpcError) return `rpc_${String(error.code).replace(/[^A-Za-z0-9]+/g, "_").toLowerCase()}`;
  return "session_resume_failed";
}

function errorCode(error: unknown): string | number {
  if (error instanceof ZcodeAppServerRpcError) return error.code;
  if (error instanceof ZcodeAppServerProcessError) return "ZCODE_PROCESS_EXITED";
  return "ZCODE_ADAPTER_ERROR";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "cancelled"));
}

function isTerminal(event: CanonicalEvent): boolean {
  return event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled";
}

function signalProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  child.kill(signal);
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function stringField(value: JsonRecord | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function numberField(value: JsonRecord | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function printableValue(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}
