/**
 * Codex app-server transport and event adaptation layer.
 *
 * Unlike the one-way NDJSON of `codex exec --json`, the app-server uses
 * bidirectional JSON-RPC 2.0 over stdin/stdout: Octo Harness both sends
 * initialize/thread/turn requests and must respond to approval/elicitation
 * requests that Codex sends back. That is why this does not reuse the generic
 * JSON CLI helper, but instead maintains a request pending map, notification
 * parser, cancellation and process-reaping state.
 *
 * This module upholds four key invariants:
 * - the provider session becomes visible to the Core only after turn/start
 *   succeeds;
 * - each invocation publishes at most one run.* terminal;
 * - only notifications for the current active thread are consumed, avoiding
 *   crosstalk;
 * - all pending RPCs and subprocess resources eventually converge via
 *   close()/finally.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import {
  freshFallbackInputText,
  providerInputText,
  type AdapterInvocationContext,
  type CanonicalEvent,
  type InvokeRequest,
  type MessageExposure
} from "@mininglamp-oss/octo-harness-adapter-sdk";

const APP_SERVER_REQUEST_TIMEOUT_MS = 30_000;
const APP_SERVER_CLOSE_GRACE_MS = 500;
const APP_SERVER_KILL_GRACE_MS = 1_000;
// Keep only the tail of stderr, balancing error diagnosability against the memory ceiling of a long-lived process.
const STDERR_TAIL_LIMIT = 64 * 1024;

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;

interface PendingRequest {
  /** Retains the business method name across a timeout or RPC error, rather than exposing only a numeric ID. */
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
  /** Executable and app-server args; tests can substitute a fake server. */
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

/** A JSON-RPC error the app-server explicitly returned, preserving method, code and raw data. */
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

/** Error for when the subprocess exits without producing a run terminal, preserving exit code/signal. */
export class CodexAppServerProcessError extends Error {
  constructor(message: string, readonly exit: ProcessExit) {
    super(message);
    this.name = "CodexAppServerProcessError";
  }
}

/** Production always uses the stdio transport; other injected args are only for a test server. */
export function buildCodexAppServerArgs(): string[] {
  return ["app-server", "--listen", "stdio://"];
}

/**
 * Execute one Octo Harness invocation and convert the native Codex event stream
 * into CanonicalEvents.
 *
 * This is the top-level protocol state machine: initialize -> thread
 * resume/start -> turn/start -> stream. The function itself drives "phase
 * advancement" and resume fallback; CodexAppServerClient owns wire I/O and
 * normalizeCodexEvent handles the pure per-notification conversion.
 */
export async function* runCodexAppServerTurn({
  request,
  spec,
  spawnFn = defaultSpawn,
  context
}: {
  request: InvokeRequest;
  spec: CodexAppServerCommand;
  spawnFn?: CodexAppServerSpawn;
  context?: AdapterInvocationContext;
}): AsyncGenerator<CanonicalEvent> {
  const requestTimeoutMs = appServerRequestTimeout(request);
  const client = new CodexAppServerClient(spec, spawnFn, requestTimeoutMs, request.signal);
  let terminal = false;

  try {
    throwIfAborted(request.signal);

    // Phase 1: negotiate the experimental app-server API first; no thread request is sent until initialize completes.
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

    // Phase 2: providerSession.sessionId is the Codex thread ID, kept opaque to the Core.
    const requestedSessionId = request.providerSession?.sessionId;
    let resumeFallback: string | undefined;
    let resumed = false;
    let threadResult: unknown;

    if (requestedSessionId) {
      try {
        threadResult = await observedRequest({
          client,
          context,
          method: "thread/resume",
          params: threadParams(request, { threadId: requestedSessionId }),
          providerSessionId: requestedSessionId
        });
        resumed = true;
      } catch (error) {
        // A failed resume does not abort this turn; record a low-cardinality reason and fall back to a fresh thread.
        resumeFallback = rpcFailureReason(error);
      }
    }

    if (!threadResult) {
      threadResult = await observedRequest({
        client,
        context,
        method: "thread/start",
        params: threadParams(request, { sessionStartSource: "startup" })
      });
    }

    let threadId = extractThreadId(threadResult);
    if (!threadId) throw new Error("codex thread start/resume returned no thread id");
    client.setActiveThread(threadId);

    // Phase 3: only a successful turn/start means this turn is truly executable.
    let turnResult: unknown;
    try {
      turnResult = await observedRequest({
        client,
        context,
        method: "turn/start",
        params: turnParams(request, threadId, resumeFallback !== undefined),
        providerSessionId: threadId
      });
    } catch (error) {
      // Some corrupt sessions pass thread/resume but only reveal the missing rollout at turn/start.
      if (!resumed || !isThreadNotFound(error)) throw error;
      resumeFallback = "turn_start_thread_not_found";
      resumed = false;
      threadResult = await observedRequest({
        client,
        context,
        method: "thread/start",
        params: threadParams(request, { sessionStartSource: "startup" })
      });
      threadId = extractThreadId(threadResult);
      if (!threadId) {
        throw new Error("codex fresh fallback returned no thread id", { cause: error });
      }
      client.setActiveThread(threadId);
      turnResult = await observedRequest({
        client,
        context,
        method: "turn/start",
        params: turnParams(request, threadId, true),
        providerSessionId: threadId
      });
    }

    const turnId = extractTurnId(turnResult);
    if (turnId) client.setActiveTurn(turnId);

    // Must come after turn/start: otherwise the Core would persist a provider session that cannot be executed.
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

    // Phase 4: the client queue has already normalized JSON-RPC notifications into CanonicalEvents.
    let firstOutput = true;
    for await (const event of client.events()) {
      // The thread RPC response already produced the authoritative initial
      // update. Later lifecycle outcomes (such as compaction) must pass through.
      if (event.type === "session.update"
        && event.payload.providerSession?.sessionId === threadId
        && event.payload.providerSession.resumeOutcome === undefined) {
        continue;
      }
      if (firstOutput) {
        firstOutput = false;
        // This is the first accepted provider notification after turn/start,
        // not merely the JSON-RPC response that acknowledged the request.
        void context?.observe({
          event: "provider.output.first",
          rpcMethod: "notification",
          providerSessionId: threadId
        });
      }
      terminal ||= isTerminalEvent(event);
      yield event;
      if (terminal) break;
    }

    if (!terminal) {
      // Ending without a terminal in the queue is a protocol/process anomaly and must not be disguised as success.
      const exit = await client.exit();
      throw new CodexAppServerProcessError(
        client.processErrorMessage(exit),
        exit
      );
    }
  } catch (error) {
    if (!terminal) {
      // AbortSignal takes priority in deciding cancelled semantics; all other errors project uniformly to provider run.error.
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
    // close() handles RPC/stdio/process; spec.cleanup handles the shadow CODEX_HOME.
    await client.close();
    await spec.cleanup?.();
  }
}

/**
 * Send one model-affecting app-server request with ordered observations.
 *
 * The carrier is the exact `{ method, params }` object serialized onto stdin;
 * it is captured before the write and awaited so strict capture can fail closed.
 * `provider.dispatch.written` comes from the stdin write callback, whereas
 * `provider.dispatch.acknowledged` requires the matching JSON-RPC response.
 * These states must not be collapsed: a locally buffered frame can still be
 * rejected, time out, or disappear with a crashed provider process.
 */
async function observedRequest({
  client,
  context,
  method,
  params,
  providerSessionId
}: {
  client: CodexAppServerClient;
  context?: AdapterInvocationContext;
  method: string;
  params: JsonRecord;
  providerSessionId?: string;
}): Promise<unknown> {
  // Do not reconstruct this from InvokeRequest: thread fallback and provider
  // defaults have already selected the exact method and params sent on the wire.
  await context?.observe({
    event: "provider.input",
    rpcMethod: method,
    ...(providerSessionId ? { providerSessionId } : {}),
    carrier: { kind: "json_params", content: { method, params } }
  });
  const response = client.request(method, params, undefined, () => {
    // The callback is reached only after Node accepts the complete NDJSON frame.
    void context?.observe({
      event: "provider.dispatch.written",
      rpcMethod: method,
      ...(providerSessionId ? { providerSessionId } : {})
    });
  });
  try {
    const result = await response;
    // A correlated response is the app-server's protocol-level acknowledgement;
    // streamed model output may arrive later as independent notifications.
    void context?.observe({
      event: "provider.dispatch.acknowledged",
      rpcMethod: method,
      ...(providerSessionId ? { providerSessionId } : {})
    });
    return result;
  } catch (error) {
    void context?.observe({
      event: "provider.dispatch.failed",
      rpcMethod: method,
      ...(providerSessionId ? { providerSessionId } : {}),
      data: { error: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  }
}

/**
 * Purely map one app-server notification into zero or more canonical events.
 *
 * Each notification is mapped and enqueued immediately on arrival, with no
 * buffering across reasoning/tool/final phases, so the interleaving order for
 * complex tasks is determined by the provider's raw arrival order. This function
 * holds no cross-frame state: request correlation, single-terminal enforcement
 * and active-thread filtering are handled by the client. Unrecognized methods
 * return an empty array, keeping forward compatibility as Codex adds
 * non-critical notifications.
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
 * JSON-RPC client for a single invocation, backed by a single app-server subprocess.
 *
 * Three kinds of frame may interleave on stdout:
 * 1. a response carrying id + result/error, which settles a Promise in #pending;
 * 2. a notification with no id, which is converted and pushed into #queue;
 * 3. a server request carrying id + method, which the adapter must respond to.
 *
 * This class does not decide the resume/fresh strategy; it only owns the wire,
 * the process and the active thread/turn state.
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
   * Cancellation follows a "converge host events first, then best-effort notify
   * the provider" order.
   *
   * The queue immediately publishes the sole run.stopped so the UI need not wait
   * for a Codex response; if the thread/turn IDs are known, turn/interrupt is
   * sent in the background. After 250ms without exit, SIGTERM follows, with the
   * final SIGKILL fallback left to close().
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

    // The app-server protocol requires one JSON-RPC frame per line; readline handles chunk boundaries.
    this.#reader = createInterface({ input: this.#child.stdout });
    this.#reader.on("line", line => this.#handleLine(line));
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string | Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-STDERR_TAIL_LIMIT);
    });

    // spawn error and normal/abnormal close are watched separately, but both ultimately reject pending RPCs and close the event stream.
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

  request(
    method: string,
    params: unknown,
    timeoutMs = this.#requestTimeoutMs,
    onWritten?: () => void
  ): Promise<unknown> {
    if (this.#closed || this.#exited) {
      return Promise.reject(new Error("codex app-server is closed"));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      // Register pending before writing stdin, so a synchronous reply from a test server/local process cannot arrive first.
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new Error(`codex app-server ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
      // onWritten is deliberately passed through to #write instead of running
      // before it; callers use it as the transport-written observation boundary.
      this.#write(
        { jsonrpc: "2.0", id, method, params },
        error => {
          const pending = this.#pending.get(id);
          if (!pending) return;
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        },
        onWritten
      );
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
   * Idempotently close the client and reap the subprocess along the ladder
   * stdin EOF -> SIGTERM -> SIGKILL.
   *
   * Before closing it removes the AbortSignal listener, closes the reader and
   * rejects pending requests, guaranteeing no Promise or event consumer hangs
   * forever. A well-behaved app-server should exit on its own after stdin EOF.
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

  /** Dispatch one stdout frame. Ordering of the checks matters: a response may also lack a method. */
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
    // A late response arriving after timeout has no pending entry; drop it so it cannot pollute the next request.
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
    // The current adapter uses non-interactive run semantics: approval is backstopped by the sandbox boundary, not forwarded to a UI.
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
        // Unknown server requests must be answered with an error, otherwise Codex waits forever on that JSON-RPC ID.
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

  #write(
    message: JsonRecord,
    onError?: (error: Error) => void,
    onWritten?: () => void
  ): void {
    if (this.#closed || this.#exited) {
      onError?.(new Error("codex app-server is closed"));
      return;
    }
    const line = `${JSON.stringify(message)}\n`;
    this.#child.stdin.write(line, error => {
      // Writable completion means local acceptance of the bytes. Only a later
      // frame with the same JSON-RPC id can acknowledge a request.
      if (error) onError?.(error);
      else onWritten?.();
    });
  }

  #acceptNotification(params: JsonRecord): boolean {
    // During initialize there is no active thread yet, so global notifications are allowed; afterward other threads are filtered out.
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
 * Bridge EventEmitter-style process callbacks into an AsyncIterable.
 *
 * values buffers events when production outpaces consumption; waiters holds
 * next() calls when consumption outpaces production. close is normal completion,
 * fail makes waiters throw. After closing, push is ignored, cleanly guaranteeing
 * no events are emitted past the terminal.
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

/** Shared params for thread/start and thread/resume; the permission policy is fixed at the thread level. */
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
 * turn/start carries this turn's input plus the per-turn overridable model,
 * effort and reasoning summary. The summary must be sent explicitly: setting only
 * effort still consumes reasoning tokens, but the app-server does not guarantee
 * publishing summaryTextDelta, so a UI might see only an empty analysis lifecycle.
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
  // The Codex app-server does not accept disabled; matching Aily behavior, use the lowest effective level low for compatibility.
  return value === "disabled" ? "low" : value;
}

/**
 * The app-server will not automatically publish reasoning summary deltas just
 * because effort was set. Chat requests auto by default; callers can tighten or
 * disable it via providerOptions.reasoningSummary.
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

/** usage carries both this turn's increment (last) and the provider cumulative value (total). */
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

/** item started only creates the lifecycle object; it does not guess the final output here. */
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

/** item completed closes the corresponding message/tool lifecycle and attaches the provider's final snapshot. */
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

/** One-to-one mapping from a Codex turn terminal to an Octo Harness run terminal. */
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
 * Flatten the various Codex items into an Octo Harness tool descriptor.
 *
 * name is the cross-provider display/lookup key; args preserve the structured raw
 * fields as much as possible. An unknown item returns undefined rather than
 * impersonating a tool, avoiding the Core persisting an unexplainable lifecycle.
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

/** Codex uses inProgress; the Octo Harness canonical contract uses running. */
function toolStatus(item: JsonRecord): string {
  const status = stringValue(item.status);
  if (status === "inProgress") return "running";
  return status || "completed";
}

/** Extract compact output for common tools; other tools keep the full item as a forward-compatible fallback. */
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

// Response shapes differ slightly across app-server versions, so the ID extractor accepts both top-level and nested fields.
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
  // Only accept known item namespaces, to avoid misprojecting an unrelated delta as tool arguments.
  return /^item\/(?:functionCall|toolCall|mcpToolCall|dynamicToolCall)\/(?:argumentsDelta|argsDelta|inputDelta|parametersDelta)$/.test(method);
}

function isTerminalEvent(event: CanonicalEvent): boolean {
  return event.type === "run.finished" || event.type === "run.error" || event.type === "run.stopped";
}

function isThreadNotFound(error: unknown): boolean {
  return error instanceof Error && /thread not found/i.test(error.message);
}

function rpcFailureReason(error: unknown): string {
  // The side channel stores only a low-cardinality classification, not the full provider error which may contain paths/credentials, into the session.
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
    // Occasional non-protocol text on stdout must not blow up the whole run; real diagnostics are still appended to the error from stderr.
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
