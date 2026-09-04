/**
 * Codex app-server transport 与事件适配层。
 *
 * 与 `codex exec --json` 的单向 NDJSON 不同，app-server 使用 stdin/stdout 上的
 * 双向 JSON-RPC 2.0：Octo Harness 既要发 initialize/thread/turn 请求，也要响应 Codex
 * 主动发来的 approval/elicitation 请求。因此这里没有复用通用 JSON CLI helper，
 * 而是维护 request pending map、notification parser、取消和进程回收状态。
 *
 * 本模块遵守四个关键不变量：
 * - provider session 只有在 turn/start 成功后才对 Core 可见；
 * - 每个 invocation 最多发布一个 run.* 终态；
 * - 只消费当前 active thread 的 notification，避免串流；
 * - 所有 pending RPC 和子进程资源最终都由 close()/finally 收敛。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import {
  freshFallbackInputText,
  providerInputText,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageExposure
} from "@mininglamp-oss/octo-harness-adapter-sdk";

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_CLOSE_GRACE_MS = 500;
const APP_SERVER_KILL_GRACE_MS = 1_000;
// stderr 只保留尾部，兼顾错误可诊断性和常驻进程的内存上限。
const STDERR_TAIL_LIMIT = 64 * 1024;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

interface PendingRequest {
  /** 用于在超时或 RPC error 中保留业务方法名，而不是只暴露数字 ID。 */
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface CodexAppServerNotification {
  method: string;
  params?: JsonRecord;
}

export interface CodexAppServerCommand {
  /** 可执行文件与 app-server 参数；测试可以替换成 fake server。 */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup?: () => void | Promise<void>;
}

export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
) => ChildProcessWithoutNullStreams;

/** app-server 明确返回的 JSON-RPC error，保留 method、code 和原始 data。 */
export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(`${method}: ${message}`);
    this.name = "CodexAppServerRpcError";
  }
}

/** 子进程未产生 run 终态就退出时的错误，保留 exit code/signal。 */
export class CodexAppServerProcessError extends Error {
  constructor(message: string, readonly exit: ProcessExit) {
    super(message);
    this.name = "CodexAppServerProcessError";
  }
}

/** 生产环境固定使用 stdio transport；注入其他参数只用于测试 server。 */
export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

/**
 * 执行一个 Octo Harness invocation，并把 Codex 原生事件流转换成 CanonicalEvent。
 *
 * 这是顶层协议状态机：initialize -> thread resume/start -> turn/start -> stream。
 * 函数本身负责“阶段推进”和 resume 降级；CodexAppServerClient 负责 wire I/O，
 * normalizeCodexEvent 负责单条 notification 的纯转换。
 */
export async function* runCodexAppServerTurn({
  request,
  spec,
  spawnFn = defaultSpawn
}: {
  request: InvokeRequest;
  spec: CodexAppServerCommand;
  spawnFn?: CodexAppServerSpawn;
}): AsyncGenerator<CanonicalEvent> {
  const requestTimeoutMs = appServerRequestTimeout(request);
  const client = new CodexAppServerClient(spec, spawnFn, requestTimeoutMs, request.signal);
  let terminal = false;

  try {
    throwIfAborted(request.signal);

    // Phase 1：先协商 experimental app-server API；未完成 initialize 不发送 thread 请求。
    await client.request("initialize", {
      clientInfo: {
        name: "@mininglamp-oss/octo-harness-adapter-codex",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "mcpServer/startupStatus/updated",
          "remoteControl/status/changed"
        ]
      }
    });
    client.notify("initialized");

    // Phase 2：providerSession.sessionId 是 Codex thread ID，对 Core 保持 opaque。
    const requestedSessionId = request.providerSession?.sessionId;
    let resumeFallback: string | undefined;
    let resumed = false;
    let threadResult: unknown;

    if (requestedSessionId) {
      try {
        threadResult = await client.request("thread/resume", threadParams(request, {
          threadId: requestedSessionId
        }));
        resumed = true;
      } catch (error) {
        // resume 失败不直接终止本轮；记录低基数原因后降级为 fresh thread。
        resumeFallback = rpcFailureReason(error);
      }
    }

    if (!threadResult) {
      threadResult = await client.request("thread/start", threadParams(request, {
        sessionStartSource: "startup"
      }));
    }

    let threadId = extractThreadId(threadResult);
    if (!threadId) throw new Error("codex thread start/resume returned no thread id");
    client.setActiveThread(threadId);

    // Phase 3：turn/start 成功才表示本轮真正可执行。
    let turnResult: unknown;
    try {
      turnResult = await client.request("turn/start", turnParams(request, threadId, resumeFallback !== undefined));
    } catch (error) {
      // 某些损坏 session 能通过 thread/resume，但在 turn/start 才暴露 rollout 缺失。
      if (!resumed || !isThreadNotFound(error)) throw error;
      resumeFallback = "turn_start_thread_not_found";
      resumed = false;
      threadResult = await client.request("thread/start", threadParams(request, {
        sessionStartSource: "startup"
      }));
      threadId = extractThreadId(threadResult);
      if (!threadId) {
        throw new Error("codex fresh fallback returned no thread id", { cause: error });
      }
      client.setActiveThread(threadId);
      turnResult = await client.request("turn/start", turnParams(request, threadId, true));
    }

    const turnId = extractTurnId(turnResult);
    if (turnId) client.setActiveTurn(turnId);

    // 必须晚于 turn/start：否则 Core 会持久化一个无法继续执行的 provider session。
    yield {
      type: "session.update",
      payload: {
        providerSession: {
          sessionId: threadId,
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

    // Phase 4：client queue 已经把 JSON-RPC notification 归一化为 CanonicalEvent。
    for await (const event of client.events()) {
      // The thread RPC response already produced the authoritative initial
      // update. Later lifecycle outcomes (such as compaction) must pass through.
      if (event.type === "session.update"
        && event.payload.providerSession?.sessionId === threadId
        && event.payload.providerSession.resumeOutcome === undefined) {
        continue;
      }
      terminal ||= isTerminalEvent(event);
      yield event;
      if (terminal) break;
    }

    if (!terminal) {
      // 队列无终态结束属于协议/进程异常，不能伪装成成功。
      const exit = await client.exit();
      throw new CodexAppServerProcessError(
        client.processErrorMessage(exit),
        exit
      );
    }
  } catch (error) {
    if (!terminal) {
      // AbortSignal 优先决定 cancelled 语义；其余异常统一投影为 provider run.error。
      if (request.signal?.aborted) {
        yield {
          type: "run.stopped",
          payload: { reason: String(request.signal.reason ?? "cancelled") }
        };
      } else {
        yield {
          type: "run.error",
          payload: { message: client.errorMessage(error), adapterType: "codex" }
        };
      }
    }
  } finally {
    // close() 负责 RPC/stdio/进程，spec.cleanup 负责 shadow CODEX_HOME。
    await client.close();
    await spec.cleanup?.();
  }
}

/**
 * 将一条 app-server notification 纯函数式映射为零到多条统一事件。
 *
 * 每条 notification 到达后立即映射并入队，不跨 reasoning/tool/final 阶段缓冲，
 * 因此复杂任务的交错顺序由 provider 原始到达顺序决定。
 * 这里不维护跨帧状态：request 关联、单终态和 active thread 过滤由 client 处理。
 * 未识别的方法返回空数组，便于 Codex 增加非关键 notification 时保持前向兼容。
 */
export function normalizeCodexEvent(native: CodexAppServerNotification): CanonicalEvent[] {
  const params = native.params ?? {};
  switch (native.method) {
    case "thread/started": {
      const threadId = stringValue(params.threadId)
        || stringValue(recordValue(params.thread)?.id)
        || stringValue(recordValue(params.thread)?.sessionId);
      return threadId ? [{
        type: "session.update",
        payload: { providerSession: { sessionId: threadId, resumable: true } }
      }] : [];
    }
    case "thread/compacted": {
      const threadId = stringValue(params.threadId)
        || stringValue(recordValue(params.thread)?.id)
        || stringValue(recordValue(params.thread)?.sessionId);
      return threadId ? [{
        type: "session.update",
        payload: {
          providerSession: {
            sessionId: threadId,
            resumable: true,
            resumeOutcome: "compacted"
          }
        }
      }] : [];
    }
    case "item/agentMessage/delta":
      return textDelta(params, "final");
    case "item/reasoning/summaryTextDelta":
      return textDelta(params, "analysis", "public_summary", "item/reasoning/summaryTextDelta");
    case "item/reasoning/textDelta":
      return textDelta(params, "analysis", "private_reasoning", "item/reasoning/textDelta");
    case "item/plan/delta":
      return textDelta(params, "analysis", "public_plan", "item/plan/delta");
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const id = itemId(params);
      const delta = stringValue(params.delta);
      return id && delta ? [{
        type: "tool_call.delta",
        payload: { id, outputDelta: delta }
      }] : [];
    }
    case "thread/tokenUsage/updated":
      return usageEvents(params);
    case "item/started":
      return itemStartedEvents(recordValue(params.item));
    case "item/completed":
      return itemCompletedEvents(recordValue(params.item));
    case "turn/completed":
      return turnCompletedEvents(recordValue(params.turn));
    case "error": {
      if (params.willRetry === true) return [];
      const error = recordValue(params.error);
      return [{
        type: "run.error",
        payload: { message: stringValue(error?.message) || "Codex turn failed" }
      }];
    }
    default: {
      if (isToolArgsDeltaMethod(native.method)) {
        const id = itemId(params);
        const delta = stringValue(params.delta);
        return id && delta ? [{
          type: "tool_call.delta",
          payload: { id, argsDelta: delta }
        }] : [];
      }
      return [];
    }
  }
}

/**
 * 单 invocation、单 app-server 子进程的 JSON-RPC client。
 *
 * stdout 中可能交错出现三种 frame：
 * 1. 带 id + result/error 的 response，完成 #pending 中的 Promise；
 * 2. 不带 id 的 notification，转换后写入 #queue；
 * 3. 带 id + method 的 server request，必须由 adapter 反向响应。
 *
 * 这个类不决定 resume/fresh 策略，只拥有 wire、进程和 active thread/turn 状态。
 */
class CodexAppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #reader: ReadLineInterface;
  readonly #queue = new AsyncEventQueue<CanonicalEvent>();
  readonly #pending = new Map<RpcId, PendingRequest>();
  readonly #requestTimeoutMs: number;
  readonly #signal?: AbortSignal;
  readonly #exitPromise: Promise<ProcessExit>;
  #resolveExit: (exit: ProcessExit) => void = () => undefined;
  #nextId = 1;
  #stderr = "";
  #closed = false;
  #closing = false;
  #exited = false;
  #terminal = false;
  #activeThreadId?: string;
  #activeTurnId?: string;
  #abortTimer?: NodeJS.Timeout;

  /**
   * 取消采用“先收敛宿主事件、再尽力通知 provider”的顺序。
   *
   * queue 立即发布唯一 run.stopped，避免 UI 等待 Codex 响应；若 thread/turn ID 已知，
   * 后台发送 turn/interrupt。250ms 后仍未退出则 SIGTERM，最终兜底由 close() SIGKILL。
   */
  readonly #abortListener = (): void => {
    if (this.#closed || this.#terminal) return;
    this.#terminal = true;
    this.#queue.push({
      type: "run.stopped",
      payload: { reason: String(this.#signal?.reason ?? "cancelled") }
    });
    this.#queue.close();
    if (this.#activeThreadId && this.#activeTurnId) {
      void this.request("turn/interrupt", {
        threadId: this.#activeThreadId,
        turnId: this.#activeTurnId
      }, 1_000).catch(() => undefined);
    }
    this.#abortTimer = setTimeout(() => this.#child.kill("SIGTERM"), 250);
    this.#abortTimer.unref?.();
  };

  constructor(
    spec: CodexAppServerCommand,
    spawnFn: CodexAppServerSpawn,
    requestTimeoutMs: number,
    signal?: AbortSignal
  ) {
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#signal = signal;
    this.#exitPromise = new Promise(resolve => {
      this.#resolveExit = resolve;
    });
    this.#child = spawnFn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env });

    // app-server 协议要求一行一个 JSON-RPC frame；readline 负责处理 chunk 边界。
    this.#reader = createInterface({ input: this.#child.stdout });
    this.#reader.on("line", line => this.#handleLine(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string | Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    // spawn error 与正常/异常 close 分开监听，但最终都会拒绝 pending RPC 并关闭事件流。
    this.#child.once("error", error => this.#handleProcessError(error));
    this.#child.once("close", (code, exitSignal) => this.#handleExit({ code, signal: exitSignal }));
    if (signal?.aborted) queueMicrotask(this.#abortListener);
    else signal?.addEventListener("abort", this.#abortListener, { once: true });
  }

  setActiveThread(threadId: string): void {
    this.#activeThreadId = threadId;
  }

  setActiveTurn(turnId: string): void {
    this.#activeTurnId = turnId;
  }

  events(): AsyncIterable<CanonicalEvent> {
    return this.#queue;
  }

  exit(): Promise<ProcessExit> {
    return this.#exitPromise;
  }

  request(method: string, params: unknown, timeoutMs = this.#requestTimeoutMs): Promise<unknown> {
    if (this.#closed || this.#exited) {
      return Promise.reject(new Error("codex app-server is closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // 先登记 pending 再写 stdin，避免测试 server/本地进程同步回包造成 response 先到。
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, params }, error => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params })
    });
  }

  /**
   * 幂等关闭 client，并按 stdin EOF -> SIGTERM -> SIGKILL 的阶梯回收子进程。
   *
   * close 前先移除 AbortSignal listener、关闭 reader、拒绝 pending request，保证没有
   * Promise 或事件消费者永久悬挂。正常 app-server 应在 stdin EOF 后自行退出。
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#closing = true;
    this.#signal?.removeEventListener("abort", this.#abortListener);
    if (this.#abortTimer) clearTimeout(this.#abortTimer);
    this.#reader.close();
    this.#rejectPending(new Error("codex app-server closed"));
    if (this.#exited) return;
    this.#child.stdin.end();
    if (await waitForExit(this.#exitPromise, APP_SERVER_CLOSE_GRACE_MS)) return;
    this.#child.kill("SIGTERM");
    if (await waitForExit(this.#exitPromise, APP_SERVER_KILL_GRACE_MS)) return;
    this.#child.kill("SIGKILL");
  }

  errorMessage(error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    return this.#stderr.trim() ? `${raw}\n\n[codex stderr]\n${this.#stderr.trim()}` : raw;
  }

  processErrorMessage(exit: ProcessExit): string {
    const base = exit.signal
      ? `codex app-server exited on ${exit.signal}`
      : `codex app-server exited with code ${exit.code ?? -1}`;
    return this.#stderr.trim() ? `${base}: ${this.#stderr.trim()}` : base;
  }

  /** 分派一条 stdout frame。判断顺序很重要：response 也可能没有 method。 */
  #handleLine(line: string): void {
    const message = parseRecord(line);
    if (!message) return;
    const id = rpcId(message.id);
    if (id !== undefined && ("result" in message || "error" in message)) {
      this.#handleResponse(id, message);
      return;
    }
    const method = stringValue(message.method);
    if (!method) return;
    if (id !== undefined) {
      this.#handleServerRequest(id, method);
      return;
    }
    const params = recordValue(message.params) ?? {};
    if (!this.#acceptNotification(params)) return;
    for (const event of normalizeCodexEvent({ method, params })) {
      this.#queue.push(event);
      if (isTerminalEvent(event)) {
        this.#terminal = true;
        this.#queue.close();
      }
    }
  }

  #handleResponse(id: RpcId, message: JsonRecord): void {
    // 超时后到达的 late response 没有 pending 项，直接丢弃，不能污染下一次请求。
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    const error = recordValue(message.error);
    if (error) {
      pending.reject(new CodexAppServerRpcError(
        pending.method,
        numberValue(error.code) ?? -32000,
        stringValue(error.message) || "unknown app-server error",
        error.data
      ));
      return;
    }
    pending.resolve(message.result);
  }

  #handleServerRequest(id: RpcId, method: string): void {
    // 当前 adapter 采用非交互运行语义：approval 由 sandbox 边界兜底，不转发到 UI。
    switch (method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
        this.#respond(id, { decision: "accept" });
        return;
      case "mcpServer/elicitation/request":
        this.#respond(id, { action: "accept", content: null, _meta: null });
        return;
      default:
        // 必须给未知 server request 回错误，否则 Codex 会一直等待这个 JSON-RPC ID。
        this.#write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `unhandled server request: ${method}` }
        });
    }
  }

  #respond(id: RpcId, result: unknown): void {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  #write(message: JsonRecord, onError?: (error: Error) => void): void {
    if (this.#closed || this.#exited) {
      onError?.(new Error("codex app-server is closed"));
      return;
    }
    const line = `${JSON.stringify(message)}\n`;
    this.#child.stdin.write(line, error => {
      if (error) onError?.(error);
    });
  }

  #acceptNotification(params: JsonRecord): boolean {
    // initialize 阶段尚无 active thread，允许全局 notification；之后过滤其他 thread。
    if (!this.#activeThreadId) return true;
    const threadId = stringValue(params.threadId);
    return !threadId || threadId === this.#activeThreadId;
  }

  #handleProcessError(error: Error): void {
    this.#rejectPending(error);
    if (!this.#closing && !this.#terminal) this.#queue.fail(error);
  }

  #handleExit(exit: ProcessExit): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#resolveExit(exit);
    const error = new CodexAppServerProcessError(this.processErrorMessage(exit), exit);
    this.#rejectPending(error);
    if (!this.#closing && !this.#terminal) this.#queue.fail(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

/**
 * 把 EventEmitter 风格的进程回调桥接成 AsyncIterable。
 *
 * values 缓存“生产快于消费”的事件，waiters 保存“消费快于生产”的 next()；close 是
 * 正常完成，fail 会让等待者抛错。关闭后 push 被忽略，从容保证终态后不再发事件。
 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (reason: Error) => void;
  }> = [];
  #closed = false;
  #error?: Error;

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: Error): void {
    if (this.#closed) return;
    this.#error = error;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      }
    };
  }
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv }
): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: process.platform === "win32"
  });
}

/** thread/start 与 thread/resume 的公共参数，权限策略在 thread 层确定。 */
function threadParams(request: InvokeRequest, extra: JsonRecord): JsonRecord {
  return {
    ...extra,
    cwd: request.workdir,
    ...(request.agentConfig.model ? { model: request.agentConfig.model } : {}),
    sandbox: codexSandbox(request),
    approvalPolicy: "never",
    developerInstructions: request.appendInstructions
  };
}

/**
 * turn/start 承载本轮输入，以及可逐轮覆盖的 model、effort 和 reasoning summary。
 * summary 必须显式发送；只设置 effort 会消耗 reasoning tokens，但 app-server 不保证发布
 * summaryTextDelta，UI 因而可能只看到空 analysis lifecycle。
 */
function turnParams(request: InvokeRequest, threadId: string, freshFallback = false): JsonRecord {
  const effort = codexEffort(request.agentConfig.thinking);
  return {
    threadId,
    input: [{
      type: "text",
      text: freshFallback ? freshFallbackInputText(request) : providerInputText(request),
      text_elements: []
    }],
    cwd: request.workdir,
    ...(request.agentConfig.model ? { model: request.agentConfig.model } : {}),
    ...(effort ? { effort } : {}),
    summary: codexReasoningSummary(request)
  };
}

function codexEffort(value: string | undefined): string | undefined {
  // Codex app-server 不接受 disabled；与 Aily 行为一致，用最低有效等级 low 兼容。
  return value === "disabled" ? "low" : value;
}

/**
 * app-server 不会因为设置了 effort 就自动发布 reasoning summary delta。
 * Chat 默认请求 auto；调用方可通过 providerOptions.reasoningSummary 收紧或关闭。
 */
function codexReasoningSummary(request: InvokeRequest): string {
  const configured = recordValue(request.agentConfig.providerOptions)?.reasoningSummary;
  const value = typeof configured === "string"
    ? configured
    : request.agentConfig.thinking === "disabled" ? "none" : "auto";
  if (!["auto", "concise", "detailed", "none"].includes(value)) {
    throw new Error(`unsupported Codex reasoning summary: ${value}`);
  }
  return value;
}

function codexSandbox(request: InvokeRequest): string {
  const value = request.agentConfig.dangerouslyBypassPermissions
    ? "danger-full-access"
    : request.agentConfig.sandbox ?? "workspace-write";
  if (!["read-only", "workspace-write", "danger-full-access"].includes(value)) {
    throw new Error(`unsupported Codex sandbox mode: ${value}`);
  }
  return value;
}

function appServerRequestTimeout(request: InvokeRequest): number {
  const configured = recordValue(request.agentConfig.providerOptions)?.appServerRequestTimeoutMs;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : APP_SERVER_REQUEST_TIMEOUT_MS;
}

/**
 * Text deltas preserve provider arrival order. Analysis deltas additionally carry
 * an adapter-signed exposure classification so a presentation can fail closed.
 */
function textDelta(
  params: JsonRecord,
  channel: "analysis" | "final",
  exposure?: MessageExposure,
  nativeEvent?: string
): CanonicalEvent[] {
  const text = stringValue(params.delta);
  if (!text) return [];
  const id = itemId(params);
  return [{
    type: "message.delta",
    payload: {
      text,
      channel,
      ...(id ? { messageId: id } : {}),
      ...(exposure && nativeEvent ? {
        exposure,
        provenance: { provider: "codex", nativeEvent }
      } : {})
    }
  }];
}

/** usage 同时保留本次增量(last)和 provider 累计值(total)。 */
function usageEvents(params: JsonRecord): CanonicalEvent[] {
  const tokenUsage = recordValue(params.tokenUsage);
  const last = recordValue(tokenUsage?.last);
  const total = recordValue(tokenUsage?.total);
  if (!last && !total) return [];
  return [{
    type: "usage.update",
    payload: {
      ...(last ?? total ?? {}),
      ...(total ? { cumulative: total } : {}),
      ...(typeof tokenUsage?.modelContextWindow === "number"
        ? { modelContextWindow: tokenUsage.modelContextWindow }
        : {})
    }
  }];
}

/** item started 只创建 lifecycle 对象，不在这里猜测最终输出。 */
function itemStartedEvents(item: JsonRecord | undefined): CanonicalEvent[] {
  if (!item) return [];
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (type === "agentMessage") {
    return [{
      type: "message.create",
      payload: { role: "assistant", status: "streaming", channel: "final", ...(id ? { messageId: id } : {}) }
    }];
  }
  if (type === "reasoning" || type === "plan") {
    const exposure: MessageExposure = type === "plan" ? "public_plan" : "unknown";
    return [{
      type: "message.create",
      payload: {
        role: "assistant",
        status: "streaming",
        channel: "analysis",
        exposure,
        provenance: { provider: "codex", nativeEvent: "item/started" },
        ...(id ? { messageId: id } : {})
      }
    }];
  }
  const tool = toolDescriptor(item);
  return tool ? [{
    type: "tool_call.create",
    payload: { id: tool.id, name: tool.name, args: tool.args }
  }] : [];
}

/** item completed 关闭对应 message/tool lifecycle，并附上 provider 的最终快照。 */
function itemCompletedEvents(item: JsonRecord | undefined): CanonicalEvent[] {
  if (!item) return [];
  const type = stringValue(item.type);
  const id = stringValue(item.id);
  if (type === "agentMessage") {
    return [{
      type: "message.update",
      payload: {
        role: "assistant",
        status: "completed",
        channel: "final",
        ...(id ? { messageId: id } : {}),
        ...(stringValue(item.text) ? { text: stringValue(item.text) } : {})
      }
    }];
  }
  if (type === "reasoning" || type === "plan") {
    const exposure: MessageExposure = type === "plan" ? "public_plan" : "public_summary";
    const text = type === "plan"
      ? stringValue(item.text)
      : stringArray(item.summary).join("\n") || undefined;
    return [{
      type: "message.update",
      payload: {
        role: "assistant",
        status: "completed",
        channel: "analysis",
        exposure,
        provenance: { provider: "codex", nativeEvent: "item/completed" },
        ...(id ? { messageId: id } : {}),
        ...(text ? { text } : {})
      }
    }];
  }
  const tool = toolDescriptor(item);
  if (!tool) return [];
  return [{
    type: "tool_call.update",
    payload: {
      id: tool.id,
      status: toolStatus(item),
      output: toolOutput(item),
      ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {})
    }
  }];
}

/** Codex turn 终态到 Octo Harness run 终态的一对一映射。 */
function turnCompletedEvents(turn: JsonRecord | undefined): CanonicalEvent[] {
  const status = stringValue(turn?.status);
  if (status === "interrupted") {
    return [{ type: "run.stopped", payload: { reason: "interrupted" } }];
  }
  if (status === "failed") {
    const error = recordValue(turn?.error);
    return [{
      type: "run.error",
      payload: { message: stringValue(error?.message) || "Codex turn failed" }
    }];
  }
  return [{ type: "run.finished", payload: {} }];
}

/**
 * 将不同 Codex item 压平为 Octo Harness 工具描述。
 *
 * name 是跨 provider 的展示/查询键；args 尽量保留结构化原始字段。未知 item 返回
 * undefined 而不是冒充工具，避免 Core 持久化无法解释的 lifecycle。
 */
function toolDescriptor(item: JsonRecord): { id: string; name: string; args: JsonRecord } | undefined {
  const id = stringValue(item.id);
  if (!id) return undefined;
  switch (stringValue(item.type)) {
    case "commandExecution":
      return {
        id,
        name: "exec_command",
        args: {
          command: stringValue(item.command),
          ...(stringValue(item.cwd) ? { cwd: stringValue(item.cwd) } : {})
        }
      };
    case "fileChange":
      return { id, name: "apply_patch", args: { changes: item.changes ?? [] } };
    case "mcpToolCall": {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool) || "tool";
      return {
        id,
        name: server ? `mcp__${server}__${tool}` : tool,
        args: recordValue(item.arguments) ?? { value: item.arguments }
      };
    }
    case "dynamicToolCall": {
      const namespace = stringValue(item.namespace);
      const tool = stringValue(item.tool) || "tool";
      return {
        id,
        name: namespace ? `${namespace}__${tool}` : tool,
        args: recordValue(item.arguments) ?? { value: item.arguments }
      };
    }
    case "collabAgentToolCall":
      return { id, name: stringValue(item.tool) || "collab_agent", args: { ...item } };
    case "webSearch":
      return { id, name: "web_search", args: { ...item } };
    case "imageView":
      return { id, name: "view_image", args: { path: item.path } };
    case "imageGeneration":
      return { id, name: "image_generation", args: { ...item } };
    case "sleep":
      return { id, name: "sleep", args: { ...item } };
    default:
      return undefined;
  }
}

/** Codex 使用 inProgress，Octo Harness canonical contract 使用 running。 */
function toolStatus(item: JsonRecord): string {
  const status = stringValue(item.status);
  if (status === "inProgress") return "running";
  return status || "completed";
}

/** 为常见工具提取紧凑输出；其他工具保留完整 item 作为前向兼容回退。 */
function toolOutput(item: JsonRecord): unknown {
  switch (stringValue(item.type)) {
    case "commandExecution":
      return item.aggregatedOutput ?? "";
    case "fileChange":
      return item.changes ?? [];
    case "mcpToolCall":
      return item.error ?? item.result ?? null;
    case "dynamicToolCall":
      return item.contentItems ?? null;
    default:
      return item;
  }
}

// app-server 版本间 response 外形略有差异，ID extractor 同时兼容顶层和嵌套字段。
function extractThreadId(value: unknown): string {
  const result = recordValue(value);
  const thread = recordValue(result?.thread);
  return stringValue(result?.threadId)
    || stringValue(result?.sessionId)
    || stringValue(thread?.id)
    || stringValue(thread?.sessionId);
}

function extractTurnId(value: unknown): string {
  const result = recordValue(value);
  return stringValue(result?.turnId) || stringValue(recordValue(result?.turn)?.id);
}

function itemId(params: JsonRecord): string {
  return stringValue(params.itemId)
    || stringValue(params.callId)
    || stringValue(recordValue(params.item)?.id);
}

function isToolArgsDeltaMethod(method: string): boolean {
  // 只接受已知 item namespace，避免把无关 delta 错投影成工具参数。
  return /^item\/(?:functionCall|toolCall|mcpToolCall|dynamicToolCall)\/(?:argumentsDelta|argsDelta|inputDelta|parametersDelta)$/.test(method);
}

function isTerminalEvent(event: CanonicalEvent): boolean {
  return event.type === "run.finished" || event.type === "run.error" || event.type === "run.stopped";
}

function isThreadNotFound(error: unknown): boolean {
  return error instanceof Error && /thread not found/i.test(error.message);
}

function rpcFailureReason(error: unknown): string {
  // side channel 只保存低基数分类，不把可能包含路径/凭证的完整 provider error 写入 session。
  const message = error instanceof Error ? error.message : String(error);
  return /rollout path/i.test(message) ? "rollout_path_missing" : "resume_rejected";
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "cancelled"));
}

function parseRecord(line: string): JsonRecord | undefined {
  try {
    return recordValue(JSON.parse(line));
  } catch {
    // stdout 偶发非协议文本不应击穿整个 run；真正诊断信息仍会从 stderr 附加到错误。
    return undefined;
  }
}

function recordValue(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

async function waitForExit(exit: Promise<ProcessExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    exit.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
