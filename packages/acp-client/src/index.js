import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

class AsyncQueue {
  items = []; waiters = []; closed = false; error;
  push(value) { const next = this.waiters.shift(); next ? next.resolve({ value, done: false }) : this.items.push(value); }
  end(error) { this.closed = true; this.error = error; for (const next of this.waiters.splice(0)) error ? next.reject(error) : next.resolve({ done: true }); }
  next() {
    if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.closed) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
  [Symbol.asyncIterator]() { return this; }
}

export class AcpClient {
  #child; #nextId = 1; #pending = new Map(); #updates = new Map(); #stderr = ""; #permission;
  constructor({ child, permissionHandler }) {
    this.#child = child; this.#permission = permissionHandler ?? denyPermission;
    child.stderr?.setEncoding("utf8"); child.stderr?.on("data", value => { this.#stderr = (this.#stderr + value).slice(-8192); });
    createInterface({ input: child.stdout }).on("line", line => {
      try { this.#receive(JSON.parse(line)); } catch (error) { this.#failAll(new Error(`invalid ACP JSON: ${error.message}`)); }
    });
    child.once("exit", (code, signal) => {
      if (this.#pending.size || this.#updates.size) this.#failAll(new Error(this.#stderr.trim() || `ACP process exited: ${code ?? signal}`));
    });
  }
  #send(message) { this.#child.stdin.write(`${JSON.stringify(message)}\n`); }
  #receive(message) {
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.#pending.get(message.id); if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message ?? "ACP request failed")) : pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      const params = message.params ?? {}; this.#updates.get(params.sessionId)?.push(params.update ?? params); return;
    }
    if (message.id !== undefined && /permission/i.test(message.method ?? "")) {
      Promise.resolve(this.#permission(message.params ?? {})).then(result => this.#send({ jsonrpc: "2.0", id: message.id, result }));
    }
  }
  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear();
    for (const queue of this.#updates.values()) queue.end(error); this.#updates.clear();
  }
  request(method, params, { timeoutMs = 300000 } = {}) {
    const id = this.#nextId++;
    let timer;
    const request = new Promise((resolve, reject) => this.#pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    }));
    this.#send({ jsonrpc: "2.0", id, method, params });
    if (timeoutMs) {
      timer = setTimeout(() => {
        const pending = this.#pending.get(id); this.#pending.delete(id);
        pending?.reject(new Error(`ACP timeout: ${method}`));
      }, timeoutMs);
      timer.unref?.();
    }
    return request;
  }
  initialize(input = {}) { return this.request("initialize", { protocolVersion: 1, clientInfo: { name: "orbtex", version: "0.1.0" }, clientCapabilities: {}, ...input }); }
  async newSession({ cwd, model }) {
    const result = await this.request("session/new", { cwd, mcpServers: [], ...(model ? { model } : {}) });
    if (!result?.sessionId) throw new Error("ACP session/new returned no sessionId");
    return { ...result, id: result.sessionId };
  }
  async loadSession(sessionId, { cwd = process.cwd() } = {}) {
    await this.request("session/load", { sessionId, cwd, mcpServers: [] }, { timeoutMs: 600000 }); return { id: sessionId };
  }
  async *prompt(sessionId, text) {
    const queue = new AsyncQueue(); this.#updates.set(sessionId, queue);
    const result = this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, { timeoutMs: 8 * 60 * 60 * 1000 })
      .then(value => { if (value?.usage) queue.push({ type: "usage", usage: value.usage, model: value.model }); queue.end(); })
      .catch(error => queue.end(error));
    try { for await (const update of queue) yield update; await result; }
    finally { this.#updates.delete(sessionId); }
  }
  cancel(sessionId) { this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } }); }
  async close() {
    if (this.#child.exitCode !== null) return;
    this.#child.kill("SIGTERM");
    await Promise.race([new Promise(resolve => this.#child.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
  }
}

export function spawnAcpClient({ command, args = [], cwd, env, signal, permissionHandler }) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const client = new AcpClient({ child, permissionHandler });
  signal?.addEventListener("abort", () => client.close(), { once: true });
  return client;
}

function denyPermission(params) {
  const options = params.options ?? [];
  const selected = options.find(option => /reject|deny/i.test(option.kind ?? option.name ?? "")) ?? options.at(-1);
  return selected ? { outcome: { outcome: "selected", optionId: selected.optionId ?? selected.id } } : { outcome: { outcome: "cancelled" } };
}
