import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  #error;
  push(value) { const waiter = this.#waiters.shift(); waiter ? waiter.resolve({ value, done: false }) : this.#items.push(value); }
  close(error) {
    this.#closed = true; this.#error = error;
    for (const waiter of this.#waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ done: true });
  }
  [Symbol.asyncIterator]() { return this; }
  next() {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

function writer(output) {
  return value => output.write(`${JSON.stringify(value)}\n`);
}

export class AdapterHostRpcServer {
  #host; #send;
  constructor({ host, output }) { this.#host = host; this.#send = writer(output); }
  listen(input) {
    createInterface({ input }).on("line", line => {
      try { this.#dispatch(JSON.parse(line)); }
      catch (error) { this.#send({ jsonrpc: "2.0", error: { code: -32700, message: error.message }, id: null }); }
    });
  }
  async #dispatch(message) {
    const { id, method, params = {} } = message;
    try {
      if (method === "list") return this.#send({ jsonrpc: "2.0", id, result: this.#host.list() });
      if (method === "probe") return this.#send({ jsonrpc: "2.0", id, result: await this.#host.probe(params.adapterType) });
      if (method === "cancel") return this.#send({ jsonrpc: "2.0", id, result: { cancelled: this.#host.cancel(params.invocationId, params.reason) } });
      if (method === "invoke") {
        this.#send({ jsonrpc: "2.0", id, result: { invocationId: params.request.invocationId } });
        this.#streamInvoke(params.adapterType, params.request); return;
      }
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
    } catch (error) {
      this.#send({ jsonrpc: "2.0", id, error: { code: error.code ?? -32000, message: error.message } });
    }
  }
  async #streamInvoke(adapterType, request) {
    try {
      for await (const event of this.#host.invoke(adapterType, request)) {
        this.#send({ jsonrpc: "2.0", method: "invoke.event", params: { invocationId: request.invocationId, event } });
      }
      this.#send({ jsonrpc: "2.0", method: "invoke.done", params: { invocationId: request.invocationId } });
    } catch (error) {
      this.#send({ jsonrpc: "2.0", method: "invoke.done", params: { invocationId: request.invocationId, error: { message: error.message } } });
    }
  }
}

export class AdapterHostRpcClient {
  #send; #pending = new Map(); #invocations = new Map();
  constructor({ input, output }) {
    this.#send = writer(output);
    const lines = createInterface({ input });
    lines.on("line", line => this.#receive(JSON.parse(line)));
    lines.on("close", () => this.close(new Error("adapter-host connection closed")));
    input.on?.("error", error => this.close(error));
  }
  #receive(message) {
    if (message.method === "invoke.event") return this.#invocations.get(message.params.invocationId)?.push(message.params.event);
    if (message.method === "invoke.done") {
      const queue = this.#invocations.get(message.params.invocationId);
      queue?.close(message.params.error ? new Error(message.params.error.message) : undefined);
      this.#invocations.delete(message.params.invocationId); return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
  }
  request(method, params = {}) {
    const id = randomUUID();
    const promise = new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    this.#send({ jsonrpc: "2.0", id, method, params }); return promise;
  }
  close(error = new Error("adapter-host client closed")) {
    for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear();
    for (const queue of this.#invocations.values()) queue.close(error); this.#invocations.clear();
  }
  list() { return this.request("list"); }
  probe(adapterType) { return this.request("probe", { adapterType }); }
  cancel(invocationId, reason) { return this.request("cancel", { invocationId, reason }); }
  async *invoke(adapterType, request) {
    const queue = new AsyncQueue(); this.#invocations.set(request.invocationId, queue);
    try {
      await this.request("invoke", { adapterType, request });
      for await (const event of queue) yield event;
    } catch (error) {
      this.#invocations.delete(request.invocationId); queue.close(); throw error;
    }
  }
}
