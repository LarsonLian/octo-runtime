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
}

export interface SpawnAcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  permissionHandler?: PermissionHandler;
}

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

export class AcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #permission: PermissionHandler;
  readonly #pending = new Map<number, Deferred<unknown>>();
  readonly #updates = new Map<string, AsyncQueue<AcpUpdate>>();
  #nextId = 1;
  #stderr = "";

  constructor({ child, permissionHandler }: { child: ChildProcessWithoutNullStreams; permissionHandler?: PermissionHandler }) {
    this.#child = child;
    this.#permission = permissionHandler ?? denyPermission;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (value: string | Buffer) => {
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

  #send(message: JsonRecord): void {
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

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
    if (typeof message.id === "number" && /permission/i.test(method)) {
      const params = asRecord(message.params);
      // ACP 的权限请求方向与普通调用相反：provider 发 request，client 必须回 response。
      void Promise.resolve(this.#permission(params)).then(
        result => this.#send({ jsonrpc: "2.0", id: message.id, result }),
        error => this.#send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: errorMessage(error) }
        })
      );
    }
  }

  #failAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const queue of this.#updates.values()) queue.end(error);
    this.#updates.clear();
  }

  request<T = unknown>(method: string, params: JsonRecord, { timeoutMs = 300_000 }: { timeoutMs?: number } = {}): Promise<T> {
    const id = this.#nextId++;
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
    this.#send({ jsonrpc: "2.0", id, method, params });
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

  initialize(input: JsonRecord = {}): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "orbtex", version: "0.1.0" },
      clientCapabilities: {},
      ...input
    });
  }

  async newSession({ cwd, model }: { cwd: string; model?: string }): Promise<JsonRecord & { id: string; sessionId: string }> {
    const result = await this.request<JsonRecord>("session/new", {
      cwd,
      mcpServers: [],
      ...(model ? { model } : {})
    });
    const sessionId = stringField(result, "sessionId");
    if (!sessionId) throw new Error("ACP session/new returned no sessionId");
    return { ...result, id: sessionId, sessionId };
  }

  async loadSession(sessionId: string, { cwd = process.cwd() }: { cwd?: string } = {}): Promise<{ id: string }> {
    await this.request("session/load", { sessionId, cwd, mcpServers: [] }, { timeoutMs: 600_000 });
    return { id: sessionId };
  }

  async *prompt(sessionId: string, text: string): AsyncGenerator<AcpUpdate> {
    const queue = new AsyncQueue<AcpUpdate>();
    this.#updates.set(sessionId, queue);
    const result = this.request<JsonRecord>(
      "session/prompt",
      { sessionId, prompt: [{ type: "text", text }] },
      { timeoutMs: 8 * 60 * 60 * 1000 }
    ).then(value => {
      if (isRecord(value.usage)) {
        queue.push({ type: "usage", usage: value.usage, ...(typeof value.model === "string" ? { model: value.model } : {}) });
      }
      queue.end();
    }).catch(error => queue.end(toError(error)));

    try {
      for await (const update of queue) yield update;
      await result;
    } finally {
      this.#updates.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
  }

  async close(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    this.#child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>(resolve => this.#child.once("exit", () => resolve())),
      new Promise<void>(resolve => setTimeout(resolve, 1000))
    ]);
    if (this.#child.exitCode === null) this.#child.kill("SIGKILL");
  }
}

export function spawnAcpClient(options: SpawnAcpClientOptions): AcpClient {
  const { command, args = [], cwd, env, signal, permissionHandler } = options;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  const client = new AcpClient({ child, permissionHandler });
  signal?.addEventListener("abort", () => void client.close(), { once: true });
  return client;
}

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
