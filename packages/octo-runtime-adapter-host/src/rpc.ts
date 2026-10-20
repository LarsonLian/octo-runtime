import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  watchLineLimit,
  readBoundedLines,
  type RuntimeLog,
  type AdapterProbeOptions
} from "@mininglamp-oss/octo-runtime-adapter-sdk";
import {
  createInputInvoke,
  HOST_RPC_MAX_LINE_BYTES,
  INVOKE_REQUEST_MAX_BYTES,
  resolveStreamLimitPolicy,
  streamCapacityError,
  assertJsonByteLimit,
  type InputFrames,
  type InvokeInput,
  type InvokeEnvironment,
  assertHostFrame,
  type InputInvoke,
  assertHostRunReceipt,
  assertHostFrameIdentity,
  isHostTerminal,
  type HostFrame,
  type HostRunReceipt,
  type NativeInteractionResponse,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type {
  AgentExecutor,
  HostedAdapterMetadata
} from "@mininglamp-oss/octo-runtime-executor-core";

type JsonRecord = Record<string, unknown>;
type RpcId = string | number | null;

export type RpcTraceDirection = "send" | "receive";
export type RpcTrace = (direction: RpcTraceDirection, frame: string) => void;

/** Stable client contract used by daemon-owned host lifecycle wrappers. */
export interface AdapterHostRpc {
  list(configurations?: Record<string, AdapterProbeOptions>): Promise<HostedAdapterMetadata[]>;
  probe(adapterType: string, options?: AdapterProbeOptions): Promise<unknown>;
  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }>;
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void>;
  respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void>;
  invoke: InputInvoke;
  invokeFrames: InputFrames;
}

interface RpcMessage extends JsonRecord {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: { code?: number; message: string; data?: { code?: string } };
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

/** A single-consumer async queue: producers `push`, one consumer iterates, and `close` ends the stream (optionally with an error). */
class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: { value: T; bytes: number }[] = [];
  #bytes = 0;
  readonly #waiters: Array<Deferred<IteratorResult<T>>> = [];
  #closed = false;
  #error?: Error;

  constructor(
    private readonly limits: {
      itemMaxBytes: number;
      maxBytes: number;
      maxItems: number;
      boundary: string;
    }
  ) {}

  push(value: T): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > this.limits.itemMaxBytes) {
      this.close(
        streamCapacityError("STREAM_QUEUE_ITEM_TOO_LARGE", {
          boundary: this.limits.boundary,
          measuredBytes: bytes,
          limitBytes: this.limits.itemMaxBytes
        })
      );
      return;
    }
    if (this.#items.length >= this.limits.maxItems) {
      this.close(
        streamCapacityError("STREAM_QUEUE_ITEMS_EXCEEDED", {
          boundary: this.limits.boundary,
          itemCount: this.#items.length + 1,
          limitItems: this.limits.maxItems
        })
      );
      return;
    }
    if (this.#bytes + bytes > this.limits.maxBytes) {
      this.close(
        streamCapacityError("STREAM_QUEUE_BYTES_EXCEEDED", {
          boundary: this.limits.boundary,
          measuredBytes: this.#bytes + bytes,
          limitBytes: this.limits.maxBytes
        })
      );
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      this.#items.push({ value, bytes });
      this.#bytes += bytes;
    }
  }

  close(error?: Error): void {
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
    if (item !== undefined) {
      this.#bytes -= item.bytes;
      return Promise.resolve({ value: item.value, done: false });
    }
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function writer(
  output: Writable,
  trace?: RpcTrace,
  onError?: (error: Error) => void
): (value: RpcMessage) => void {
  return (value) => {
    try {
      const frame = JSON.stringify(value);
      trace?.("send", traceFrame(value, frame));
      output.write(`${frame}\n`, (error) => {
        if (error) onError?.(error);
      });
    } catch (error) {
      if (!onError) throw error;
      onError(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  };
}

/**
 * Expose an AdapterHost as a line-delimited JSON-RPC 2.0 service.
 * Ordinary methods use request/response; a long-running invoke uses an ACK plus
 * a notification event stream.
 */
export class AdapterHostRpcServer {
  readonly #log: RuntimeLog;
  readonly #controllers = new Map<string, AbortController>();
  readonly #host: AgentExecutor;
  readonly #send: (value: RpcMessage) => void;
  readonly #trace: RpcTrace | undefined;
  readonly #output: Writable;
  #closed = false;

  constructor({
    host,
    output,
    trace,
    log
  }: {
    host: AgentExecutor;
    output: Writable;
    trace?: RpcTrace;
    log?: RuntimeLog;
  }) {
    this.#log = (level, event, data) => {
      try {
        log?.(level, event, data);
      } catch {
        /* 诊断不能破坏协议流。 */
      }
    };
    this.#host = host;
    this.#output = output;
    const send = writer(output, trace, (error) => this.#close(error));
    this.#send = (value) => {
      if (!this.#closed) send(value);
    };
    this.#trace = trace;
    output.on("error", (error) => this.#close(error));
  }

  /** Start consuming the input stream; each line must be one complete JSON-RPC object. */
  listen(input: Readable): void {
    readBoundedLines(input, INVOKE_REQUEST_MAX_BYTES, {
      onTooLarge: () =>
        this.#send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message: "INVOKE_REQUEST_TOO_LARGE",
            data: { code: "INVOKE_REQUEST_TOO_LARGE" }
          }
        }),
      onError: (error) => this.#close(error),
      onClose: () => this.#close(new Error("adapter-host parent connection closed")),
      onLine: (line) => {
        if (this.#closed) return;
        try {
          const message = asRpcMessage(JSON.parse(line));
          if (
            message.method !== "invoke" &&
            message.method !== "invoke.with-environment" &&
            Buffer.byteLength(line) > 512 * 1024
          ) {
            this.#send({
              jsonrpc: "2.0",
              id: message.id ?? null,
              error: { code: -32000, message: "RPC_REQUEST_TOO_LARGE" }
            });
            return;
          }
          this.#trace?.("receive", traceFrame(message, line));
          void this.#dispatch(message);
        } catch (error) {
          this.#send({
            jsonrpc: "2.0",
            error: { code: -32700, message: errorMessage(error) },
            id: null
          });
        }
      }
    });
  }

  async #dispatch(message: RpcMessage): Promise<void> {
    if (this.#closed) return;
    const { id = null, method, params = {} } = message;
    try {
      if (method === "list") {
        this.#send({
          jsonrpc: "2.0",
          id,
          result: await this.#host.describe(probeConfigurations(params.configurations))
        });
        return;
      }
      if (method === "probe") {
        this.#send({
          jsonrpc: "2.0",
          id,
          result: await this.#host.probe(
            requiredString(params.adapterType, "adapterType"),
            probeOptions(params.options)
          )
        });
        return;
      }
      if (method === "cancel") {
        const invocationId = requiredString(params.invocationId, "invocationId");
        const reason = typeof params.reason === "string" ? params.reason : undefined;
        const controller = this.#controllers.get(invocationId);
        controller?.abort(new Error(reason ?? "cancelled"));
        this.#send({
          jsonrpc: "2.0",
          id,
          result: {
            cancelled: this.#host.cancel(invocationId, reason) || !!controller
          }
        });
        return;
      }
      if (method === "interaction.respond") {
        await this.#host.respondInteraction(
          requiredString(params.invocationId, "invocationId"),
          params.response as InteractionResponse
        );
        this.#send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "native.respond") {
        await this.#host.respondNative(
          requiredString(params.invocationId, "invocationId"),
          params.response as NativeInteractionResponse
        );
        this.#send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "invoke" || method === "invoke.with-environment") {
        const input = params.input as InvokeInput;
        this.#log("info", "rpc.invoke_received", {
          invocation_id: input?.invocationId,
          run_id: input?.runId,
          session_id: input?.sessionId
        });
        const invocationId = requiredString(input?.invocationId, "invocationId");
        if (this.#controllers.has(invocationId)) throw new Error("EXECUTION_IDENTITY_CONFLICT");
        const controller = new AbortController();
        const source = this.#host.invokeFrames(input, {
          signal: controller.signal,
          ...(method === "invoke.with-environment"
            ? {
                executionEnvOverrides:
                  params.executionEnvOverrides as InvokeEnvironment["executionEnvOverrides"],
                streamLimits: resolveStreamLimitPolicy(
                  params.streamLimits as InvokeEnvironment["streamLimits"]
                )
              }
            : {})
        });
        this.#controllers.set(invocationId, controller);
        let first: IteratorResult<HostFrame>;
        try {
          first = await source.next();
        } catch (error) {
          this.#controllers.delete(invocationId);
          throw error;
        }
        if (first.done) {
          this.#controllers.delete(invocationId);
          throw new Error("HOST_ENDED_WITHOUT_RECEIPT");
        }
        const {
          run_id,
          invocation_id,
          stream_id,
          agent_session_id,
          session_generation,
          protocol_mode,
          protocol
        } = first.value;
        const receipt = {
          run_id,
          invocation_id,
          stream_id,
          agent_session_id,
          session_generation,
          protocol_mode,
          protocol
        };
        this.#send({ jsonrpc: "2.0", id, result: receipt });
        void this.#streamInvoke(
          invocationId,
          (async function* () {
            yield first.value;
            yield* source;
          })()
        );
        return;
      }
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: {
          code: errorCode(error),
          message: errorMessage(error),
          ...(isRecord(error) && typeof error.code === "string"
            ? { data: { code: error.code } }
            : {})
        }
      });
    }
  }

  async #streamInvoke(invocationId: string, source: AsyncIterable<HostFrame>): Promise<void> {
    if (this.#closed) return;
    const started = Date.now();
    let failed = false;
    try {
      for await (const event of source) {
        if (this.#closed) break;
        this.#send({
          jsonrpc: "2.0",
          method: "invoke.event",
          params: { invocationId, event }
        });
        if (this.#output.writableNeedDrain) await this.#waitForDrain();
      }
      this.#send({
        jsonrpc: "2.0",
        method: "invoke.done",
        params: { invocationId }
      });
    } catch (error) {
      failed = true;
      this.#send({
        jsonrpc: "2.0",
        method: "invoke.done",
        params: {
          invocationId,
          error: { message: errorMessage(error), ...safeStreamErrorDetails(error) }
        }
      });
    } finally {
      this.#log(failed ? "error" : "info", "rpc.stream_closed", {
        invocation_id: invocationId,
        duration_ms: Date.now() - started,
        status: failed || this.#closed ? "unknown" : "ended"
      });
      this.#controllers.delete(invocationId);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#controllers.values()) controller.abort(error);
    this.#controllers.clear();
    void this.#host
      .shutdown(error.message)
      .then((result) => {
        if (result.cleanup === "incomplete")
          this.#log("error", "rpc.cleanup_incomplete", {
            code: "EXECUTOR_CLEANUP_INCOMPLETE",
            unresolved_count: result.unresolvedInvocationIds.length
          });
      })
      .catch(() => undefined);
  }
  #waitForDrain(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#output.off("drain", drain);
        this.#output.off("error", fail);
        this.#output.off("close", closed);
      };
      const drain = (): void => {
        cleanup();
        resolve();
      };
      const fail = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const closed = (): void => fail(new Error("adapter-host output closed"));
      const timer = setTimeout(() => fail(new Error("STREAM_BACKPRESSURE_TIMEOUT")), 5000);
      this.#output.once("drain", drain);
      this.#output.once("error", fail);
      this.#output.once("close", closed);
    });
  }
}

/** The async client for AdapterHostRpcServer; it also reassembles invoke notifications back into an AsyncGenerator. */
export class AdapterHostRpcClient implements AdapterHostRpc {
  readonly invoke = createInputInvoke((input, environment) =>
    this.invokeFrames(input, environment)
  );
  readonly #send: (value: RpcMessage) => void;
  readonly #pending = new Map<string, Deferred<unknown>>();
  readonly #invocations = new Map<string, AsyncQueue<HostFrame>>();
  #closedError?: Error;

  constructor({
    input,
    output,
    trace,
    maximumInputBytes = HOST_RPC_MAX_LINE_BYTES
  }: {
    input: Readable;
    output: Writable;
    trace?: RpcTrace;
    maximumInputBytes?: number;
  }) {
    this.#send = writer(output, trace, (error) => this.close(error));
    const removeGuard = watchLineLimit(input, maximumInputBytes, (error) => {
      const measuredBytes =
        "measuredBytes" in error && typeof error.measuredBytes === "number"
          ? error.measuredBytes
          : undefined;
      const failure = streamCapacityError("HOST_FRAME_TOO_LARGE", {
        boundary: "host.rpc_transport",
        limitBytes: maximumInputBytes,
        ...(measuredBytes === undefined ? {} : { measuredBytes })
      });
      failure.cause = error;
      this.close(failure);
      input.destroy(failure);
    });
    const lines = createInterface({ input });
    lines.once("close", removeGuard);
    lines.on("line", (line) => {
      try {
        const message = asRpcMessage(JSON.parse(line));
        trace?.("receive", traceFrame(message, line));
        this.#receive(message);
      } catch (error) {
        this.close(new Error(`invalid adapter-host RPC: ${errorMessage(error)}`));
      }
    });
    lines.on("close", () => this.close(new Error("adapter-host connection closed")));
    lines.on("error", (error) => this.close(error));
    input.on("error", (error) => this.close(error));
    output.on("error", (error) => this.close(error));
  }

  #receive(message: RpcMessage): void {
    if (message.method === "invoke.event") {
      const params = message.params ?? {};
      const invocationId = requiredString(params.invocationId, "invocationId");
      assertHostFrame(params.event);
      this.#invocations.get(invocationId)?.push(params.event);
      return;
    }
    if (message.method === "invoke.done") {
      const params = message.params ?? {};
      const invocationId = requiredString(params.invocationId, "invocationId");
      const queue = this.#invocations.get(invocationId);
      const detail = isRecord(params.error) ? params.error : undefined;
      const rpcError = detail
        ? Object.assign(new Error(errorMessage(detail)), safeStreamErrorDetails(detail))
        : undefined;
      queue?.close(rpcError);
      this.#invocations.delete(invocationId);
      return;
    }
    if (typeof message.id !== "string") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.error)
      pending.reject(
        Object.assign(new Error(message.error.message), {
          code: message.error.data?.code ?? message.error.code
        })
      );
    else pending.resolve(message.result);
  }

  /** Send an ordinary JSON-RPC request and await the matching response by random ID. */
  request<T = unknown>(method: string, params: JsonRecord = {}, signal?: AbortSignal): Promise<T> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    if (signal?.aborted) return Promise.reject(abortError(signal));
    signal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    const id = randomUUID();
    const message: RpcMessage = { jsonrpc: "2.0", id, method, params };
    try {
      assertJsonByteLimit(
        message,
        method === "invoke" || method === "invoke.with-environment"
          ? INVOKE_REQUEST_MAX_BYTES
          : 512 * 1024,
        method === "invoke" || method === "invoke.with-environment"
          ? "INVOKE_REQUEST_TOO_LARGE"
          : "RPC_REQUEST_TOO_LARGE"
      );
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("RPC_REQUEST_INVALID"));
    }
    const promise = new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal));
      };
      this.#pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    this.#send(message);
    return promise as Promise<T>;
  }

  /** Close the logical connection and end every pending request/invocation with the same error. */
  close(error = new Error("adapter-host client closed")): void {
    if (this.#closedError) return;
    this.#closedError = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const queue of this.#invocations.values()) queue.close(error);
    this.#invocations.clear();
  }

  list(configurations?: Record<string, AdapterProbeOptions>): Promise<HostedAdapterMetadata[]> {
    return this.request("list", { configurations });
  }

  probe(adapterType: string, options?: AdapterProbeOptions): Promise<unknown> {
    return this.request("probe", { adapterType, options });
  }

  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }> {
    return this.request("cancel", { invocationId, reason });
  }

  async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
    await this.request("interaction.respond", { invocationId, response });
  }
  async respondNative(invocationId: string, response: NativeInteractionResponse): Promise<void> {
    await this.request("native.respond", { invocationId, response });
  }
  /** Await the invoke ACK first, then keep yielding this invocation's event notifications until done. */
  async *invokeFrames(
    input: InvokeInput,
    environment: InvokeEnvironment = {}
  ): AsyncGenerator<HostFrame> {
    const { signal, executionEnvOverrides } = environment;
    const streamLimits = resolveStreamLimitPolicy(environment.streamLimits);
    const invocationId = input.invocationId ?? randomUUID();
    const wireInput = { ...input, invocationId };
    if (signal?.aborted) throw abortError(signal);
    if (this.#invocations.has(invocationId)) throw new Error("EXECUTION_IDENTITY_CONFLICT");
    const queue = new AsyncQueue<HostFrame>({
      itemMaxBytes: streamLimits.hostFrameMaxBytes,
      maxBytes: streamLimits.rpcQueueMaxBytes,
      maxItems: streamLimits.rpcQueueMaxItems,
      boundary: "host.rpc_queue"
    });
    let terminal = false;
    let accepted = false;
    this.#invocations.set(invocationId, queue);
    // AbortSignal 只留在本进程；跨进程发送明确的 cancel RPC，不能序列化成空对象。
    const onAbort = (): void => {
      queue.close(abortError(signal!));
      void this.request(
        "cancel",
        { invocationId, reason: "caller_aborted" },
        AbortSignal.timeout(2000)
      ).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const receipt = await this.request(
        executionEnvOverrides?.env_variables.length || environment.streamLimits
          ? "invoke.with-environment"
          : "invoke",
        {
          input: wireInput,
          ...(executionEnvOverrides ? { executionEnvOverrides } : {}),
          ...(environment.streamLimits ? { streamLimits } : {})
        },
        signal
      );
      assertHostRunReceipt(receipt);
      accepted = true;
      assertReceiptInput(receipt, wireInput);
      let seq = 0;
      for await (const event of queue) {
        if (signal?.aborted) throw abortError(signal);
        assertHostFrameIdentity(event, receipt);
        if (event.seq !== ++seq) throw new Error("STREAM_GAP");
        if (terminal) throw new Error("HOST_FRAME_AFTER_TERMINAL");
        terminal = isHostTerminal(event);
        yield event;
      }
      if (!terminal) throw new Error("HOST_ENDED_WITHOUT_TERMINAL");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.#invocations.delete(invocationId);
      queue.close();
      if (accepted && !terminal && !signal?.aborted)
        await this.request(
          "cancel",
          { invocationId, reason: "consumer_closed" },
          AbortSignal.timeout(2000)
        ).catch(() => undefined);
    }
  }
}

function assertReceiptInput(receipt: HostRunReceipt, input: InvokeInput): void {
  if (
    (input.runId !== undefined && receipt.run_id !== input.runId) ||
    receipt.invocation_id !== input.invocationId ||
    (input.sessionId !== undefined && receipt.agent_session_id !== input.sessionId) ||
    receipt.session_generation !== (input.sessionGeneration ?? 0) ||
    receipt.protocol_mode !== (input.protocol_mode ?? "native")
  )
    throw new Error("EXECUTION_IDENTITY_CONFLICT");
}

function asRpcMessage(value: unknown): RpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0")
    throw new TypeError("expected a JSON-RPC 2.0 object");
  return value as RpcMessage;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeStreamErrorDetails(value: unknown): JsonRecord {
  if (!isRecord(value)) return {};
  const result: JsonRecord = {};
  if (typeof value.code === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(value.code))
    result.code = value.code;
  if (typeof value.boundary === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value.boundary))
    result.boundary = value.boundary;
  for (const key of ["measuredBytes", "limitBytes", "itemCount", "limitItems"] as const) {
    const entry = value[key];
    if (typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0) result[key] = entry;
  }
  return result;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function errorCode(error: unknown): number {
  return isRecord(error) && typeof error.code === "number" ? error.code : -32000;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("adapter invocation aborted");
}

function traceFrame(message: RpcMessage, raw: string): string {
  const params = message.params ?? {};
  const event = isRecord(params.event) ? params.event : {};
  const input = isRecord(params.input) ? params.input : {};
  const canonical = isRecord(event.event) ? event.event : {};
  return JSON.stringify({
    jsonrpc: message.jsonrpc,
    id: message.id,
    method: message.method,
    invocationId: params.invocationId ?? input.invocationId,
    protocolMode: event.protocol_mode ?? input.protocol_mode,
    eventType: canonical.type,
    frameKind: event.kind,
    bytes: Buffer.byteLength(raw)
  });
}

function probeOptions(value: unknown): AdapterProbeOptions | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid probe options");
  const options = value as AdapterProbeOptions;
  if (
    options.providerOptions !== undefined &&
    (!options.providerOptions ||
      typeof options.providerOptions !== "object" ||
      Array.isArray(options.providerOptions) ||
      Object.values(options.providerOptions).some((v) => typeof v !== "string"))
  )
    throw new TypeError("invalid probe provider options");
  return {
    ...options,
    ...(options.streamLimits === undefined
      ? {}
      : { streamLimits: resolveStreamLimitPolicy(options.streamLimits) })
  };
}
function probeConfigurations(value: unknown): Record<string, AdapterProbeOptions> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid probe configurations");
  return Object.fromEntries(
    Object.entries(value).map(([type, options]) => [type, probeOptions(options) ?? {}])
  );
}
