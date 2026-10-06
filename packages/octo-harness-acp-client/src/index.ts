import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type JsonRecord = Record<string, unknown>;
type PermissionHandler = (params: JsonRecord) => unknown;

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

export interface AcpUpdate extends JsonRecord {
  type?: string;
  usage?: JsonRecord;
  model?: string;
  stopReason?: string;
  finishReason?: string;
}

export interface SpawnAcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  permissionHandler?: PermissionHandler;
  onPermissionResponseWritten?: (params: JsonRecord) => void;
  onPermissionResponseFailed?: (params: JsonRecord, error: Error) => void;
}

export interface AcpRequestOptions {
  timeoutMs?: number;
  onWritten?: () => void;
  /** A real JSON-RPC id previously allocated by `reserveRequestId`. */
  requestId?: number;
}

/** Build the exact params serialized by `session/new`. */
export function acpNewSessionParams({ cwd, model }: { cwd: string; model?: string }): JsonRecord {
  return { cwd, mcpServers: [], ...(model ? { model } : {}) };
}

/** Build the exact params serialized by `session/load`. */
export function acpLoadSessionParams(sessionId: string, { cwd = process.cwd() }: { cwd?: string } = {}): JsonRecord {
  return { sessionId, cwd, mcpServers: [] };
}

/** Build the exact params serialized by `session/prompt`. */
export function acpPromptParams(sessionId: string, text: string): JsonRecord {
  return { sessionId, prompt: [{ type: "text", text }] };
}

/**
 * A single-consumer async queue used to hand `session/update` notifications from
 * the JSON-RPC receive loop to a `prompt` generator. `push` resolves a waiting
 * `next()` directly or buffers; `end` closes the stream, propagating an error to
 * pending waiters when the underlying process failed.
 */
class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<Deferred<IteratorResult<T>>> = [];
  private closed = false;
  private error?: Error;

  push(value: T): void {
    const next = this.waiters.shift();
    if (next) next.resolve({ value, done: false });
    else this.items.push(value);
  }

  end(error?: Error): void {
    this.closed = true;
    this.error = error;
    for (const next of this.waiters.splice(0)) {
      if (error) next.reject(error);
      else next.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.items.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/**
 * JSON-RPC 2.0 client for an ACP (Agent Client Protocol) subprocess, used by the
 * CodeBuddy adapter. Frames are newline-delimited JSON over the child's stdio.
 * The client multiplexes three inbound message kinds on one stdout stream:
 * responses matched to outbound requests by numeric `id`, `session/update`
 * notifications routed to the per-session update queue, and inbound permission
 * *requests* the client must answer. If the process dies with work outstanding,
 * every pending request and update queue is failed with the captured stderr.
 */
export class AcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #permission: PermissionHandler;
  readonly #permissionWritten?: (params: JsonRecord) => void;
  readonly #permissionFailed?: (params: JsonRecord, error: Error) => void;
  readonly #pending = new Map<number, Deferred<unknown>>();
  readonly #updates = new Map<string, AsyncQueue<AcpUpdate>>();
  #nextId = 1;
  #stderr = "";
  #closed = false;

  constructor({ child, permissionHandler, onPermissionResponseWritten, onPermissionResponseFailed }: { child: ChildProcessWithoutNullStreams; permissionHandler?: PermissionHandler; onPermissionResponseWritten?: (params: JsonRecord) => void; onPermissionResponseFailed?: (params: JsonRecord, error: Error) => void }) {
    this.#child = child;
    this.#permission = permissionHandler ?? denyPermission;
    this.#permissionWritten = onPermissionResponseWritten;
    this.#permissionFailed = onPermissionResponseFailed;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (value: string | Buffer) => {
      // Keep only the tail; stderr is diagnostic context for a failure, not a log sink.
      this.#stderr = (this.#stderr + value.toString()).slice(-8192);
    });
    createInterface({ input: child.stdout }).on("line", line => {
      try {
        this.#receive(asRecord(JSON.parse(line)));
      } catch (error) {
        this.#failAll(new Error(`invalid ACP JSON: ${errorMessage(error)}`));
      }
    });
    child.once("exit", (code, signal) => {
      if (this.#pending.size || this.#updates.size) {
        this.#failAll(new Error(this.#stderr.trim() || `ACP process exited: ${code ?? signal}`));
      }
    });
  }

  #send(message: JsonRecord, onWritten?: () => void, onFailed?: (error: Error) => void): void {
    // The write callback confirms acceptance by Node's stdin stream. It does not
    // imply that the ACP peer parsed the frame; the matching JSON-RPC response
    // remains the acknowledgement boundary.
    const failed = (error: Error): void => { onFailed?.(error); this.#failAll(error); };
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`, error => {
        if (error) failed(error);
        else onWritten?.();
      });
    } catch (error) { failed(toError(error)); }
  }

  /** Dispatch one inbound JSON-RPC message: response by id, `session/update` notification, or an inbound permission request. */
  #receive(message: JsonRecord): void {
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined) pending.reject(new Error(errorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "session/update") {
      const params = asRecord(message.params);
      const sessionId = stringField(params, "sessionId");
      if (sessionId) this.#updates.get(sessionId)?.push(asRecord(params.update ?? params));
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    if ((typeof message.id === "number" || typeof message.id === "string") && method === "session/request_permission") {
      const params = asRecord(message.params);
      // ACP inverts the usual call direction for permissions: the provider
      // sends the request and the client must reply with a response.
      void Promise.resolve().then(() => this.#permission(params)).then(
        result => this.#send({ jsonrpc: "2.0", id: message.id, result }, () => this.#permissionWritten?.(params), error => this.#permissionFailed?.(params, error)),
        error => this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: errorMessage(error) }
        })
      );
    }
  }

  /** Reject every outstanding request and close every update queue with the same error; used when the subprocess dies or emits invalid JSON. */
  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const queue of this.#updates.values()) queue.end(error);
    this.#updates.clear();
  }

  /**
   * Allocate the JSON-RPC id that a later request will put on the wire. This
   * lets callers durably record the exact request identity before dispatch
   * without fabricating an adapter-local correlation id.
   */
  reserveRequestId(): number {
    return this.#nextId++;
  }

  /**
   * Issue a JSON-RPC request and resolve with its `result`.
   *
   * `onWritten` runs after the serialized frame is accepted by the child stdin
   * stream and therefore precedes acknowledgement by the peer. A per-call
   * timeout (unref'd, so it never keeps Node alive) rejects if no response
   * arrives.
   */
  request<T = unknown>(
    method: string,
    params: JsonRecord,
    { timeoutMs = 300_000, onWritten, requestId }: AcpRequestOptions = {}
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("ACP client closed"));
    const id = requestId ?? this.reserveRequestId();
    if (this.#pending.has(id)) {
      return Promise.reject(new Error(`ACP request id ${id} is already pending`));
    }
    let timer: NodeJS.Timeout | undefined;
    const request = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: value => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
    });
    this.#send({ jsonrpc: "2.0", id, method, params }, onWritten);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const pending = this.#pending.get(id);
        this.#pending.delete(id);
        pending?.reject(new Error(`ACP timeout: ${method}`));
      }, timeoutMs);
      timer.unref();
    }
    return request as Promise<T>;
  }

  /** ACP handshake; must precede any session call. Advertises client info and (empty) capabilities. */
  initialize(input: JsonRecord = {}): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "octo-harness", version: "0.1.0" },
      clientCapabilities: {},
      ...input
    });
  }

  /** Start a fresh provider session and return its ACP `sessionId` (also aliased as `id`); throws if the provider omits it. */
  async newSession(
    input: { cwd: string; model?: string },
    options: AcpRequestOptions = {}
  ): Promise<JsonRecord & { id: string; sessionId: string }> {
    const result = await this.request<JsonRecord>("session/new", acpNewSessionParams(input), options);
    const sessionId = stringField(result, "sessionId");
    if (!sessionId) throw new Error("ACP session/new returned no sessionId");
    return { ...result, id: sessionId, sessionId };
  }

  /** Resume a prior provider session by id; the long timeout accommodates providers that replay history on load. */
  async loadSession(
    sessionId: string,
    input: { cwd?: string } = {},
    options: AcpRequestOptions = {}
  ): Promise<{ id: string }> {
    await this.request("session/load", acpLoadSessionParams(sessionId, input), {
      ...options,
      timeoutMs: options.timeoutMs ?? 600_000
    });
    return { id: sessionId };
  }

  /**
   * Send a prompt and stream the session's `session/update` events until the
   * turn completes. The `session/prompt` response is awaited concurrently: its
   * terminal `usage`/`model` and prompt stop reason are pushed as final
   * synthetic updates before the queue closes, or a rejection closes the queue
   * with that error. The
   * per-session queue is always removed in `finally`. The multi-hour timeout
   * covers long autonomous turns. `onWritten` observes only the outbound
   * `session/prompt` frame; completion of this generator implies the correlated
   * JSON-RPC response was received and is the provider acknowledgement boundary.
   */
  async *prompt(
    sessionId: string,
    text: string,
    {
      onWritten,
      requestId,
      params = acpPromptParams(sessionId, text)
    }: Pick<AcpRequestOptions, "onWritten" | "requestId"> & { params?: JsonRecord } = {}
  ): AsyncGenerator<AcpUpdate> {
    const queue = new AsyncQueue<AcpUpdate>();
    this.#updates.set(sessionId, queue);
    const result = this.request<JsonRecord>(
      "session/prompt",
      params,
      { timeoutMs: 8 * 60 * 60 * 1000, onWritten, requestId }
    ).then(value => {
      if (isRecord(value.usage)) {
        queue.push({ type: "usage", usage: value.usage, ...(typeof value.model === "string" ? { model: value.model } : {}) });
      }
      queue.push({
        ...value,
        type: "prompt_result",
        ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}),
        ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {})
      });
      queue.end();
    }).catch(error => queue.end(toError(error)));

    try {
      for await (const update of queue) yield update;
      await result;
    } finally {
      this.#updates.delete(sessionId);
    }
  }

  /** Fire-and-forget cancel notification (no id, so no response is expected) asking the provider to abort the turn. */
  cancel(sessionId: string): void {
    this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  /** Terminate the subprocess: SIGTERM, then escalate to SIGKILL if it has not exited within one second. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("ACP client closed"));
    if (this.#child.exitCode !== null) return;
    signalProcessTree(this.#child, "SIGTERM");
    await new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); this.#child.removeListener("exit", done); resolve(); };
      const timer = setTimeout(done, 1000);
      this.#child.once("exit", done);
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) done();
    });
    if (this.#child.exitCode === null && this.#child.signalCode === null) signalProcessTree(this.#child, "SIGKILL");
  }
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

/**
 * Spawn an ACP provider subprocess and wrap it in an `AcpClient`. On non-Windows
 * the child is detached into its own process group so cleanup can signal the
 * whole tree; aborting `signal` closes the client (and thus the process).
 */
export function spawnAcpClient(options: SpawnAcpClientOptions): AcpClient {
  const { command, args = [], cwd, env, signal, permissionHandler, onPermissionResponseWritten, onPermissionResponseFailed } = options;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const client = new AcpClient({ child, permissionHandler, onPermissionResponseWritten, onPermissionResponseFailed });
  const abort = (): void => { void client.close(); };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal?.removeEventListener("abort", abort));
  return client;
}

/**
 * Default permission handler for unattended runs: pick the explicit reject/deny
 * option if the provider offered one (falling back to the last option), else
 * cancel the request outright. Keeps a headless run from stalling on a prompt.
 */
function denyPermission(params: JsonRecord): JsonRecord {
  const options = Array.isArray(params.options) ? params.options.filter(isRecord) : [];
  const selected = options.find(option => {
    const label = stringField(option, "kind") ?? stringField(option, "name") ?? "";
    return /reject|deny/i.test(label);
  }) ?? options.at(-1);
  return selected
    ? { outcome: { outcome: "selected", optionId: selected.optionId ?? selected.id } }
    : { outcome: { outcome: "cancelled" } };
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new TypeError("expected an object");
  return value;
}

function stringField(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}
