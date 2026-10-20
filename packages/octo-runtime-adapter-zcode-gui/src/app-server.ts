import { createProcessCleanup } from "@mininglamp-oss/octo-runtime-adapter-sdk/process-cleanup";
import {
  DriverQueue,
  watchLineLimit,
  initialControlInstructions,
  hasImageInput,
  freshFallbackInputText,
  providerInputText,
  type AcpApprovalBridge,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  canonicalTerminalStatus,
  resolveStreamLimitPolicy,
  type StreamLimitPolicy
} from "@mininglamp-oss/octo-runtime-protocol";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

const REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 250;
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
  constructor(
    message: string,
    readonly exit: ProcessExit
  ) {
    super(message);
    this.name = "ZcodeAppServerProcessError";
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

export function normalizeZcodeEvent(
  event: ZcodeSessionEvent,
  state: NormalizerState
): CanonicalEvent[] {
  const payload = asRecord(event.payload) ?? {};
  const events: CanonicalEvent[] = [];
  const ensureStep = (): void => {
    if (state.stepStarted) return;
    state.stepStarted = true;
    events.push({
      protocolVersion: 2,
      type: "model_step.started",
      payload: { stepId: state.stepId }
    });
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
        events.push({
          protocolVersion: 2,
          type: "message.create",
          payload: {
            messageId: `${state.stepId}:final`,
            role: "assistant",
            status: "streaming",
            channel: "final",
            stepId: state.stepId
          }
        });
      }
      appendPublicText(state, text);
      events.push({
        protocolVersion: 2,
        type: "message.delta",
        payload: {
          messageId: `${state.stepId}:final`,
          text,
          channel: "final",
          stepId: state.stepId
        }
      });
      return events;
    }
    if (kind === "reasoning_delta") {
      const text = stringField(payload, "delta");
      if (!text) return events;
      if (!state.reasoningMessageStarted) {
        state.reasoningMessageStarted = true;
        events.push({
          protocolVersion: 2,
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
      events.push({
        protocolVersion: 2,
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
      const status =
        numberField(payload, "errorCount") && numberField(payload, "errorCount")! > 0
          ? "failed"
          : "completed";
      for (const id of ids) {
        const tool = state.tools.get(id);
        if (!tool || tool.terminal) continue;
        tool.terminal = true;
        events.push({
          protocolVersion: 2,
          type: "tool_call.update",
          payload: {
            id,
            name: tool.name,
            args: tool.input,
            status: canonicalTerminalStatus(status),
            stepId: state.stepId
          }
        });
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
    if (
      kind !== "result" &&
      kind !== "error" &&
      (kind === "scheduled" || !toolCreated(events, state, id))
    ) {
      const created = ensureToolCreated(state, id);
      if (created) events.push(created);
    }
    if (kind === "scheduled") return events;
    if (kind === "started") {
      return events;
    }
    if (kind === "progress") {
      events.push({
        protocolVersion: 2,
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
      events.push({
        protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id,
          name: tool.name,
          args: tool.input,
          status: canonicalTerminalStatus("completed"),
          output: payload.result,
          stepId: state.stepId
        }
      });
      return events;
    }
    if (kind === "error") {
      tool.terminal = true;
      events.push({
        protocolVersion: 2,
        type: "tool_call.update",
        payload: {
          id,
          name: tool.name,
          args: tool.input,
          status: canonicalTerminalStatus("failed"),
          error: asRecord(payload.error) ?? {
            message: printableValue(payload.error, "ZCode tool failed")
          },
          stepId: state.stepId
        }
      });
    }
    return events;
  }

  if (event.type === "session.updated") {
    const usage = asRecord(payload.usage);
    if (usage)
      events.push({
        protocolVersion: 2,
        type: "usage.update",
        payload: {
          ...usage,
          ...(payload.contextWindow !== undefined ? { contextWindow: payload.contextWindow } : {})
        }
      });
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
      events.push({
        protocolVersion: 2,
        type: "model_step.finished",
        payload: {
          stepId: state.stepId,
          status: canonicalTerminalStatus(
            failed ? "failed" : cancelled ? "cancelled" : "completed"
          ),
          finishReason: resultType
        }
      });
    }
    if (state.reasoningMessageStarted) {
      events.push({
        protocolVersion: 2,
        type: "message.update",
        payload: {
          messageId: `${state.stepId}:reasoning`,
          role: "assistant",
          status: failed ? "failed" : cancelled ? "stopped" : "completed"
        }
      });
    }
    if (state.finalMessageStarted) {
      events.push({
        protocolVersion: 2,
        type: "message.update",
        payload: {
          messageId: `${state.stepId}:final`,
          role: "assistant",
          status: failed ? "failed" : cancelled ? "stopped" : "completed"
        }
      });
    }
    if (failed) {
      const error = asRecord(payload.error);
      events.push({
        protocolVersion: 2,
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
  spawnFn = defaultSpawn,
  context,
  approvalBridge
}: {
  request: InvokeRequest;
  spec: ZcodeAppServerCommand;
  context?: AdapterInvocationContext;
  spawnFn?: ZcodeAppServerSpawn;
  approvalBridge?: AcpApprovalBridge;
}): AsyncGenerator<CanonicalEvent> {
  if (hasImageInput(request))
    throw new Error("UNSUPPORTED_INPUT_MODALITY: zcode-gui does not encode image input");
  if (request.approvalMode === "assisted" || (request.approvalMode === "ask" && !approvalBridge))
    throw new Error("APPROVAL_MODE_UNSUPPORTED");
  if (request.agentConfig.model)
    throw new Error(
      "EXECUTION_SELECTION_UNSUPPORTED: zcode independent model selection is not qualified"
    );
  const autoApprove = request.approvalMode === "full_access";
  const client = new ZcodeAppServerClient({
    spec,
    spawnFn,
    requestTimeoutMs: requestTimeout(request),
    autoApprove,
    streamLimits: context?.streamLimits,
    permissionHandler: approvalBridge
      ? async (params, write) => {
          const permission = {
            toolCall: {
              title: typeof params.reason === "string" ? params.reason : "ZCode tool permission"
            },
            options: [
              { kind: "allow_once", optionId: "allow" },
              { kind: "reject_once", optionId: "deny" }
            ]
          };
          try {
            const result = await approvalBridge.requestPermission(permission);
            await write({
              decision:
                (result.outcome as { optionId?: string })?.optionId === "allow" ? "allow" : "deny"
            });
            approvalBridge.responseWritten(permission);
          } catch (error) {
            approvalBridge.responseFailed(
              permission,
              error instanceof Error ? error : new Error(String(error))
            );
            throw error;
          }
        }
      : undefined
  });
  approvalBridge?.bindTransport(() => client.close());
  let sessionId: string | undefined;
  let terminal = false;
  let abortTimer: NodeJS.Timeout | undefined;
  const abort = (): void => {
    if (sessionId) client.notify("session/stop", { sessionId });
    abortTimer ??= setTimeout(() => {
      void client.close().catch(() => undefined);
    }, CLOSE_GRACE_MS);
    abortTimer.unref();
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
        sessionResult = await client.request("session/resume", {
          sessionId: requestedSessionId,
          workspace
        });
        sessionId = extractSessionId(sessionResult) ?? requestedSessionId;
        resumed = true;
      } catch (error) {
        resumeFallback = failureReason(error);
      }
    }

    if (!sessionId) {
      const mode = zcodeMode(request);
      sessionResult = await client.request("session/create", { workspace, mode });
      sessionId = extractSessionId(sessionResult);
      if (!sessionId) throw new Error("ZCode session/create returned no session id");
    }

    client.setActiveSession(sessionId);
    await client.request("session/subscribe", {
      sessionId,
      deliveryKind: "desktop-continuous",
      includeSnapshot: false,
      afterSeq: 0
    });

    const input = resumeFallback ? freshFallbackInputText(request) : providerInputText(request);
    const content = initialControlInstructions(request, !resumed)
      ? `${input}\n\n${initialControlInstructions(request, !resumed)}`
      : input;
    const sendResult = await client.request("session/send", { sessionId, content });
    if (asRecord(sendResult)?.accepted === false)
      throw new Error("ZCode session/send was not accepted");

    yield {
      protocolVersion: 2,
      type: "session.update",
      payload: {
        providerSession: {
          sessionId,
          resumable: true,
          ...(resumed ? { resumeOutcome: "resumed" } : {}),
          ...(resumeFallback
            ? {
                resumeOutcome: "fresh_fallback",
                resumeFallback,
                contextInputVariant: request.freshFallbackModelInput ? "recovery" : "primary"
              }
            : {})
        }
      }
    };

    const normalizer = new ZcodeEventNormalizer(request.runId);
    for await (const nativeEvent of client.events()) {
      const events = normalizer.normalize(nativeEvent);
      if (events.length === 0) continue;
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
        yield {
          protocolVersion: 2,
          type: "run.cancelled",
          payload: { reason: String(request.signal.reason ?? "cancelled") }
        };
      } else {
        yield {
          protocolVersion: 2,
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
    if (abortTimer) clearTimeout(abortTimer);
    await closeZcodeResources(client, spec);
  }
}

async function closeZcodeResources(
  client: ZcodeAppServerClient,
  spec: ZcodeAppServerCommand
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await client.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await spec.cleanup?.();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "ZCode resource cleanup failed");
}

class ZcodeAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #events: DriverQueue<ZcodeSessionEvent>;
  readonly #streamLimits: Readonly<StreamLimitPolicy>;
  readonly #requestTimeoutMs: number;
  readonly #autoApprove: boolean;
  readonly #permissionHandler?: (
    params: JsonRecord,
    write: (result: JsonRecord) => Promise<void>
  ) => Promise<void>;
  readonly #exitPromise: Promise<ProcessExit>;
  #resolveExit!: (exit: ProcessExit) => void;
  #nextId = 1;
  #stderr = "";
  #activeSession?: string;
  #lastSeq = 0;
  #closed = false;
  readonly #cleanup: () => Promise<void>;
  readonly #reader: ReturnType<typeof createInterface>;
  #closePromise?: Promise<void>;
  #failure?: Error;
  readonly #removeLineGuard: () => void;

  constructor({
    spec,
    spawnFn,
    requestTimeoutMs,
    autoApprove,
    streamLimits,
    permissionHandler
  }: {
    spec: ZcodeAppServerCommand;
    spawnFn: ZcodeAppServerSpawn;
    requestTimeoutMs: number;
    autoApprove: boolean;
    streamLimits?: StreamLimitPolicy;
    permissionHandler?: (
      params: JsonRecord,
      write: (result: JsonRecord) => Promise<void>
    ) => Promise<void>;
  }) {
    this.#streamLimits = resolveStreamLimitPolicy(streamLimits);
    this.#events = new DriverQueue<ZcodeSessionEvent>({
      limits: this.#streamLimits,
      boundary: "zcode.event_queue",
      onFailure: (error) => this.#failAll(error)
    });
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#autoApprove = autoApprove;
    this.#permissionHandler = permissionHandler;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
    this.#child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: process.platform !== "win32"
    });
    this.#cleanup = createProcessCleanup(this.#child, {
      processGroup: process.platform !== "win32"
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (value: string | Buffer) => {
      this.#stderr = (this.#stderr + value.toString()).slice(-STDERR_TAIL_LIMIT);
    });
    for (const source of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) {
      source.on("error", (error: Error) => this.#failAll(error));
    }
    // ZCode 不支持图片输入，所有原生行使用本 invocation 的 Provider 上限。
    // .octospec/tasks/pr1-yujiawei-review/assessment.md
    this.#removeLineGuard = watchLineLimit(
      this.#child.stdout,
      this.#streamLimits.rawMessageMaxBytes,
      (error) => {
        Object.assign(error, { boundary: "zcode.stdout" });
        this.#failAll(error);
        this.#child.stdout.destroy();
      }
    );
    this.#reader = createInterface({ input: this.#child.stdout });
    this.#reader.on("error", (error) => this.#failAll(error));
    this.#reader.on("line", (line) => this.#receiveLine(line));
    this.#child.once("error", (error) => {
      this.#resolveExit({ code: null, signal: null });
      this.#failAll(error);
    });
    // leader exit 启动组回收，close 后才认定 stdout 已排空。
    this.#child.once("exit", () => {
      void this.#cleanup().catch((error: Error) => this.#failAll(error));
    });
    this.#child.once("close", (code, signal) => {
      const exit = { code, signal };
      this.#resolveExit(exit);
      if (!this.#closed)
        this.#failAll(
          new ZcodeAppServerProcessError(this.processErrorMessage(exit), exit),
          code !== 0
        );
    });
  }

  reserveRequestId(): number {
    return this.#nextId++;
  }

  setActiveSession(sessionId: string): void {
    this.#activeSession = sessionId;
  }

  request(
    method: string,
    params: JsonRecord,
    onWritten?: () => void,
    requestId?: RpcId
  ): Promise<unknown> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new Error("ZCode app-server client closed"));
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

  events(): AsyncIterable<ZcodeSessionEvent> {
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
    return (
      this.#stderr.trim() ||
      `ZCode app-server exited before a terminal event: ${exit.code ?? exit.signal ?? "unknown"}`
    );
  }

  // S03：leader 先退出仍须回收其独立组；所有关闭路径等待同一 Promise。
  // .octospec/tasks/pr1-yujiawei-review/assessment.md
  close(): Promise<void> {
    return (this.#closePromise ??= this.#close());
  }

  async #close(): Promise<void> {
    this.#closed = true;
    this.#reader.close();
    this.#failAll(new Error("ZCode app-server client closed"));
    await this.#cleanup();
  }

  #receiveLine(line: string): void {
    if (this.#failure || this.#closed) return;
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
        pending.reject(
          new ZcodeAppServerRpcError(
            pending.method,
            typeof error.code === "string" || typeof error.code === "number"
              ? error.code
              : "ZCODE_RPC_ERROR",
            stringField(error, "message") ?? "ZCode RPC failed",
            error.detail
          )
        );
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
    this.#events.push({
      sessionId,
      type,
      ...(seq !== undefined ? { seq } : {}),
      payload: asRecord(params?.payload)
    });
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
        void this.#permissionHandler(
          params,
          (result) =>
            new Promise<void>((resolve, reject) => {
              this.#child.stdin.write(`${JSON.stringify({ id, result })}\n`, (error) =>
                error ? reject(error) : resolve()
              );
            })
        ).catch((error) =>
          this.#failAll(error instanceof Error ? error : new Error(String(error)))
        );
        return;
      }
      this.#reply(
        id,
        this.#autoApprove
          ? { decision: "allow" }
          : { decision: "deny", reason: "Octo Runtime unattended policy denied this tool request" }
      );
      return;
    }
    if (method === "interaction/requestUserInput") {
      const planApproval = asRecord(params.schema)?.interaction === "plan_approval";
      this.#reply(
        id,
        this.#autoApprove && planApproval
          ? { action: "accept", content: { answer_0: "approve" } }
          : { action: "decline", reason: "Octo Runtime has no interactive input channel for ZCode" }
      );
      return;
    }
    this.#write({
      id,
      error: { code: -32601, message: `unsupported ZCode client request: ${method}` }
    });
  }

  #reply(id: RpcId, result: unknown): void {
    this.#write({ id, result });
  }

  #write(message: JsonRecord, onWritten?: () => void): void {
    if (this.#failure || this.#closed) return;
    if (this.#child.stdin.destroyed) {
      this.#failAll(new Error("ZCode stdin closed"));
      return;
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.#failAll(error);
      else onWritten?.();
    });
  }

  #failAll(error: Error, discard = true): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#reader.close();
    this.#removeLineGuard();
    void this.#cleanup().catch(() => undefined);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    if (discard) this.#events.drain();
    this.#events.close(error);
  }
}

function ensureToolCreated(state: NormalizerState, id: string): CanonicalEvent | undefined {
  const tool = state.tools.get(id);
  if (!tool || tool.created) return undefined;
  tool.created = true;
  return {
    protocolVersion: 2,
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
  return (
    events.some((event) => event.type === "tool_call.create" && event.payload.id === id) ||
    state.tools.get(id)?.created === true
  );
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
  if (error instanceof ZcodeAppServerRpcError)
    return `rpc_${String(error.code)
      .replace(/[^A-Za-z0-9]+/g, "_")
      .toLowerCase()}`;
  return "session_resume_failed";
}

function errorCode(error: unknown): string | number {
  if (error instanceof Error && "code" in error && typeof error.code === "string")
    return error.code;
  if (error instanceof ZcodeAppServerRpcError) return error.code;
  if (error instanceof ZcodeAppServerProcessError) return "ZCODE_PROCESS_EXITED";
  return "ZCODE_ADAPTER_ERROR";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error(String(signal.reason ?? "cancelled"));
}

function isTerminal(event: CanonicalEvent): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean }
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], { ...options, stdio: ["pipe", "pipe", "pipe"] });
}

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
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
