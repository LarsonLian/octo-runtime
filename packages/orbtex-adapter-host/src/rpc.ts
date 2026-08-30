import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { CanonicalEvent, InvokeRequest } from "@orbtex-ai/orbtex-protocol";
import type { AdapterHost, HostedAdapterMetadata } from "./index.js";

type JsonRecord = Record<string, unknown>;
type RpcId = string | number | null;

export type RpcTraceDirection = "send" | "receive";
export type RpcTrace = (direction: RpcTraceDirection, frame: string) => void;

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
 * 把 AdapterHost 暴露为按行分帧的 JSON-RPC 2.0 服务。
 * 普通方法使用 request/response；长时间 invoke 使用 ACK + notification event stream。
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

  /** 开始消费输入流；每行必须是一个完整 JSON-RPC 对象。 */
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
        this.#send({ jsonrpc: "2.0", id, result: this.#host.list() });
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
      if (method === "invoke") {
        const request = params.request as InvokeRequest;
        const adapterType = requiredString(params.adapterType, "adapterType");
        // 先 ACK invocationId，再用 notification 持续推送事件，控制面不会被长任务占住。
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

/** AdapterHostRpcServer 的异步 client，同时把 invoke notifications 还原为 AsyncGenerator。 */
export class AdapterHostRpcClient {
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

  /** 发送普通 JSON-RPC request，并按随机 ID 等待对应 response。 */
  request<T = unknown>(method: string, params: JsonRecord = {}): Promise<T> {
    const id = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    this.#send({ jsonrpc: "2.0", id, method, params });
    return promise as Promise<T>;
  }

  /** 关闭逻辑连接，并让全部 pending request/invocation 以同一错误结束。 */
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

  /** 先等待 invoke ACK，再持续产出该 invocation 的 event notifications，直到 done。 */
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
