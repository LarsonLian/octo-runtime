import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { CanonicalEvent, InteractionResponse, InvokeRequest } from "@mininglamp-oss/octo-harness-protocol";
import type { AdapterHost, HostedAdapterMetadata } from "./index.js";

type JsonRecord = Record<string, unknown>;
type RpcId = string | number | null;

export type RpcTraceDirection = "send" | "receive";
export type RpcTrace = (direction: RpcTraceDirection, frame: string) => void;

/** Stable client contract used by daemon-owned host lifecycle wrappers. */
export interface AdapterHostRpc {
  list(): Promise<HostedAdapterMetadata[]>;
  probe(adapterType: string): Promise<unknown>;
  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }>;
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void>;
  invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent>;
}

interface RpcMessage extends JsonRecord {
  jsonrpc: "2.0";
  id?: RpcId;
  method?: string;
  params?: JsonRecord;
  result?: unknown;
  error?: { code?: number; message: string };
}

interface Deferred<T> {
  resolve(value: T): void;
  reject(error: Error): void;
}

/** A single-consumer async queue: producers `push`, one consumer iterates, and `close` ends the stream (optionally with an error). */
class AsyncQueue<T> implements AsyncIterableIterator<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<Deferred<IteratorResult<T>>> = [];
  #closed = false;
  #error?: Error;

  push(value: T): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#items.push(value);
  }

  close(error?: Error): void {
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.#items.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

function writer(output: Writable, trace?: RpcTrace): (value: RpcMessage) => void {
  return value => {
    const frame = JSON.stringify(value);
    trace?.("send", frame);
    output.write(`${frame}\n`);
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

  constructor({ host, output, trace }: { host: AdapterHost; output: Writable; trace?: RpcTrace }) {
    this.#host = host;
    this.#send = writer(output, trace);
    this.#trace = trace;
  }

  /** Start consuming the input stream; each line must be one complete JSON-RPC object. */
  listen(input: Readable): void {
    createInterface({ input }).on("line", line => {
      this.#trace?.("receive", line);
      try {
        void this.#dispatch(asRpcMessage(JSON.parse(line)));
      } catch (error) {
        this.#send({ jsonrpc: "2.0", error: { code: -32700, message: errorMessage(error) }, id: null });
      }
    });
  }

  async #dispatch(message: RpcMessage): Promise<void> {
    const { id = null, method, params = {} } = message;
    try {
      if (method === "list") {
        this.#send({ jsonrpc: "2.0", id, result: await this.#host.describe() });
        return;
      }
      if (method === "probe") {
        this.#send({ jsonrpc: "2.0", id, result: await this.#host.probe(requiredString(params.adapterType, "adapterType")) });
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
      if (method === "invoke") {
        const request = params.request as InvokeRequest;
        const adapterType = requiredString(params.adapterType, "adapterType");
        // ACK the invocationId first, then keep pushing events via notifications, so the control plane is not held by a long task.
        this.#send({ jsonrpc: "2.0", id, result: { invocationId: request?.invocationId } });
        void this.#streamInvoke(adapterType, request);
        return;
      }
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: errorCode(error), message: errorMessage(error) }
      });
    }
  }

  async #streamInvoke(adapterType: string, request: InvokeRequest): Promise<void> {
    try {
      for await (const event of this.#host.invoke(adapterType, request)) {
        this.#send({ jsonrpc: "2.0", method: "invoke.event", params: { invocationId: request.invocationId, event } });
      }
      this.#send({ jsonrpc: "2.0", method: "invoke.done", params: { invocationId: request.invocationId } });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        method: "invoke.done",
        params: { invocationId: request.invocationId, error: { message: errorMessage(error) } }
      });
    }
  }
}

/** The async client for AdapterHostRpcServer; it also reassembles invoke notifications back into an AsyncGenerator. */
export class AdapterHostRpcClient implements AdapterHostRpc {
  readonly #send: (value: RpcMessage) => void;
  readonly #pending = new Map<string, Deferred<unknown>>();
  readonly #invocations = new Map<string, AsyncQueue<CanonicalEvent>>();

  constructor({ input, output, trace }: { input: Readable; output: Writable; trace?: RpcTrace }) {
    this.#send = writer(output, trace);
    const lines = createInterface({ input });
    lines.on("line", line => {
      trace?.("receive", line);
      try {
        this.#receive(asRpcMessage(JSON.parse(line)));
      } catch (error) {
        this.close(new Error(`invalid adapter-host RPC: ${errorMessage(error)}`));
      }
    });
    lines.on("close", () => this.close(new Error("adapter-host connection closed")));
    input.on("error", error => this.close(error));
  }

  #receive(message: RpcMessage): void {
    if (message.method === "invoke.event") {
      const params = message.params ?? {};
      const invocationId = requiredString(params.invocationId, "invocationId");
      this.#invocations.get(invocationId)?.push(params.event as CanonicalEvent);
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
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  /** Send an ordinary JSON-RPC request and await the matching response by random ID. */
  request<T = unknown>(method: string, params: JsonRecord = {}): Promise<T> {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return promise as Promise<T>;
  }

  /** Close the logical connection and end every pending request/invocation with the same error. */
  close(error = new Error("adapter-host client closed")): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const queue of this.#invocations.values()) queue.close(error);
    this.#invocations.clear();
  }

  list(): Promise<HostedAdapterMetadata[]> {
    return this.request("list");
  }

  probe(adapterType: string): Promise<unknown> {
    return this.request("probe", { adapterType });
  }

  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }> {
    return this.request("cancel", { invocationId, reason });
  }

  async respondInteraction(invocationId: string, response: InteractionResponse): Promise<void> {
    await this.request("interaction.respond", { invocationId, response });
  }

  /** Await the invoke ACK first, then keep yielding this invocation's event notifications until done. */
  async *invoke(adapterType: string, request: InvokeRequest): AsyncGenerator<CanonicalEvent> {
    const queue = new AsyncQueue<CanonicalEvent>();
    this.#invocations.set(request.invocationId, queue);
    try {
      await this.request("invoke", { adapterType, request });
      for await (const event of queue) yield event;
    } catch (error) {
      this.#invocations.delete(request.invocationId);
      queue.close();
      throw error;
    }
  }
}

function asRpcMessage(value: unknown): RpcMessage {
  if (!isRecord(value) || value.jsonrpc !== "2.0") throw new TypeError("expected a JSON-RPC 2.0 object");
  return value as RpcMessage;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
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
