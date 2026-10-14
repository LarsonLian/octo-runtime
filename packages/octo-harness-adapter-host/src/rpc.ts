import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { watchLineLimit, type AdapterProbeOptions } from "@mininglamp-oss/octo-harness-adapter-sdk";
import {
  assertHostFrame,
  createHostInvoke,
  type HostInvoke,
  assertHostRunReceipt,
  assertHostFrameIdentity,
  isHostTerminal,
  serializeHostInvokeOptions,
  resolveHostInvokeWireOptions,
  resolveHostInvokeOptions,
  type HostFrame,
  type HostRunReceipt,
  type HostInvokeOptions,
  type NativeInteractionResponse,
  type InteractionResponse,
  type InvokeRequest
} from "@mininglamp-oss/octo-harness-protocol";
import type { AdapterHost, HostedAdapterMetadata } from "./index.js";

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
  invoke: HostInvoke;
  invokeFrames(
    adapterType: string,
    request: InvokeRequest,
    options?: HostInvokeOptions
  ): AsyncGenerator<HostFrame>;
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
  readonly #items: T[] = [];
  #bytes = 0;
  readonly #waiters: Array<Deferred<IteratorResult<T>>> = [];
  #closed = false;
  #error?: Error;

  push(value: T): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 256 * 1024 || this.#items.length >= 4096 || this.#bytes + bytes > 4 * 1024 * 1024) {
      this.close(new Error("STREAM_BUFFER_OVERFLOW"));
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else {
      this.#items.push(value);
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
    const value = this.#items.shift();
    if (value !== undefined) {
      this.#bytes -= Buffer.byteLength(JSON.stringify(value));
      return Promise.resolve({ value, done: false });
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
  readonly #host: AdapterHost;
  readonly #send: (value: RpcMessage) => void;
  readonly #trace: RpcTrace | undefined;
  readonly #output: Writable;
  #closed = false;

  constructor({ host, output, trace }: { host: AdapterHost; output: Writable; trace?: RpcTrace }) {
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
    const removeGuard = watchLineLimit(input, 512 * 1024, (error) => {
      this.#close(error);
      input.destroy(error);
    });
    const lines = createInterface({ input });
    lines.once("close", removeGuard);
    lines.on("close", () => this.#close(new Error("adapter-host parent connection closed")));
    input.on("error", (error) => this.#close(error));
    lines.on("line", (line) => {
      if (this.#closed) return;
      try {
        const message = asRpcMessage(JSON.parse(line));
        this.#trace?.("receive", traceFrame(message, line));
        void this.#dispatch(message);
      } catch (error) {
        this.#send({
          jsonrpc: "2.0",
          error: { code: -32700, message: errorMessage(error) },
          id: null
        });
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
        this.#send({
          jsonrpc: "2.0",
          id,
          result: {
            cancelled: this.#host.cancel(
              requiredString(params.invocationId, "invocationId"),
              typeof params.reason === "string" ? params.reason : undefined
            )
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
      if (method === "invoke") {
        const request = params.request as InvokeRequest;
        const adapterType = requiredString(params.adapterType, "adapterType");
        const options = resolveHostInvokeWireOptions(params.options);
        const receipt = this.#host.prepare(adapterType, request, options);
        const source = this.#host.invokeFrames(adapterType, request, options);
        this.#send({ jsonrpc: "2.0", id, result: receipt });
        void this.#streamInvoke(request, source);
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

  async #streamInvoke(request: InvokeRequest, source: AsyncIterable<HostFrame>): Promise<void> {
    if (this.#closed) return;
    try {
      for await (const event of source) {
        if (this.#closed) break;
        this.#send({
          jsonrpc: "2.0",
          method: "invoke.event",
          params: { invocationId: request.invocationId, event }
        });
        if (this.#output.writableNeedDrain) await this.#waitForDrain();
      }
      this.#send({
        jsonrpc: "2.0",
        method: "invoke.done",
        params: { invocationId: request.invocationId }
      });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        method: "invoke.done",
        params: { invocationId: request.invocationId, error: { message: errorMessage(error) } }
      });
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    void this.#host.shutdown(error.message).catch(() => undefined);
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
  readonly invoke = createHostInvoke((type, request, options) =>
    this.invokeFrames(type, request, options)
  );
  readonly #send: (value: RpcMessage) => void;
  readonly #pending = new Map<string, Deferred<unknown>>();
  readonly #invocations = new Map<string, AsyncQueue<HostFrame>>();
  #closedError?: Error;

  constructor({ input, output, trace }: { input: Readable; output: Writable; trace?: RpcTrace }) {
    this.#send = writer(output, trace, (error) => this.close(error));
    const removeGuard = watchLineLimit(input, 512 * 1024, (error) => {
      this.close(error);
      input.destroy(error);
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
      const rpcError = isRecord(params.error) ? new Error(errorMessage(params.error)) : undefined;
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
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
        this.#pending.delete(id);
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortError(signal!));
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
    this.#send({ jsonrpc: "2.0", id, method, params });
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
    adapterType: string,
    request: InvokeRequest,
    options: HostInvokeOptions = {}
  ): AsyncGenerator<HostFrame> {
    const { signal, ...wireRequest } = request;
    if (signal?.aborted) throw abortError(signal);
    if (this.#invocations.has(request.invocationId)) throw new Error("EXECUTION_IDENTITY_CONFLICT");
    const queue = new AsyncQueue<HostFrame>();
    let terminal = false;
    let accepted = false;
    this.#invocations.set(request.invocationId, queue);
    // AbortSignal 只留在本进程；跨进程发送明确的 cancel RPC，不能序列化成空对象。
    const onAbort = (): void => {
      queue.close(abortError(signal!));
      void this.request(
        "cancel",
        { invocationId: request.invocationId, reason: "caller_aborted" },
        AbortSignal.timeout(2000)
      ).catch(() => undefined);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const receipt = await this.request(
        "invoke",
        { adapterType, request: wireRequest, options: serializeHostInvokeOptions(options) },
        signal
      );
      assertHostRunReceipt(receipt);
      accepted = true;
      assertReceiptRequest(receipt, request, options);
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
      this.#invocations.delete(request.invocationId);
      queue.close();
      if (accepted && !terminal && !signal?.aborted)
        await this.request(
          "cancel",
          { invocationId: request.invocationId, reason: "consumer_closed" },
          AbortSignal.timeout(2000)
        ).catch(() => undefined);
    }
  }
}

function assertReceiptRequest(
  receipt: HostRunReceipt,
  request: InvokeRequest,
  options: HostInvokeOptions
): void {
  const selected = resolveHostInvokeOptions(options);
  if (
    receipt.run_id !== request.runId ||
    receipt.invocation_id !== request.invocationId ||
    receipt.agent_session_id !== request.agentSessionId ||
    receipt.session_generation !== (request.sessionGeneration ?? 0) ||
    receipt.protocol_mode !== selected.protocolMode ||
    (selected.protocol !== undefined && receipt.protocol !== selected.protocol)
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
  const options = isRecord(params.options) ? params.options : {};
  if (
    message.method === "native.respond" ||
    event.protocol_mode === "native" ||
    (isRecord(message.result) && message.result.protocol_mode === "native") ||
    (["invoke", "prepare"].includes(message.method ?? "") && options.protocol_mode !== "canonical")
  ) {
    return JSON.stringify({
      jsonrpc: message.jsonrpc,
      id: message.id,
      method: message.method,
      invocationId: params.invocationId,
      protocolMode: "native",
      frameKind: event.kind,
      bytes: Buffer.byteLength(raw)
    });
  }
  return raw;
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
  return options;
}
function probeConfigurations(value: unknown): Record<string, AdapterProbeOptions> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid probe configurations");
  return Object.fromEntries(
    Object.entries(value).map(([type, options]) => [type, probeOptions(options) ?? {}])
  );
}
