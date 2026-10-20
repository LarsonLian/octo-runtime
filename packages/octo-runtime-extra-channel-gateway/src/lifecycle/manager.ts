import type { ImBotConfig } from "../contracts.js";
import type { ImModuleDependencies } from "../ports.js";
import { ImRuntime } from "../application/im-channel.js";
import { HostSessionStore } from "../application/host-session-store.js";
import type { JsonObject } from "@mininglamp-oss/octo-runtime-daemon";

import {
  imBotIdentity,
  validateImConfig,
  IM_MAX_BOTS,
  IM_MAX_CONFIG_OPERATIONS
} from "./configuration.js";

interface Endpoint {
  runtime?: ImRuntime;
  store?: HostSessionStore;
  closing?: Promise<void>;
}

/** Serial updates replace only the target connection. */
export class ImChannelManager {
  readonly #endpoints = new Map<string, Endpoint>();
  #queue: Promise<void> = Promise.resolve();
  #operations = 0;
  #closed = false;
  #closing?: Promise<void>;
  readonly #abort = new AbortController();
  #detachOwner?: () => void;
  constructor(readonly dependencies: ImModuleDependencies) {
    if (dependencies.sessions && dependencies.createSessionStore)
      throw new Error("IM_SESSION_STORE_SOURCE_CONFLICT");
    // Extra loader 要等 initializer 退出才运行 disposer；owner abort 必须立即启动
    // 本层清理与撤权计时，不能让不合作的初始化无限保留宿主数据库访问。
    const owner = dependencies.signal;
    if (owner) {
      const stop = () => {
        void this.close().catch(() => {
          try {
            dependencies.log?.("warn", "channel.diagnostic", { code: "IM_DISPOSE_FAILED" });
          } catch {
            /* 诊断不能改变清理结果，onDispose 会再次取得同一失败 Promise。 */
          }
        });
      };
      this.#detachOwner = () => owner.removeEventListener("abort", stop);
      owner.addEventListener("abort", stop, { once: true });
      if (owner.aborted) stop();
    }
  }
  get status(): Record<string, unknown>[] {
    return [...this.#endpoints.values()].flatMap(({ runtime }) =>
      runtime ? [{ ...runtime.status }] : []
    );
  }
  upsert(config: ImBotConfig): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new Error("IM_MANAGER_CLOSED"));
    if (this.#operations >= IM_MAX_CONFIG_OPERATIONS)
      return Promise.reject(new Error("IM_CONFIG_QUEUE_CAPACITY_EXHAUSTED"));
    let snapshot: ImBotConfig;
    try {
      validateImConfig(config);
      snapshot = structuredClone(config);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("IM_CONFIG_INVALID"));
    }
    return this.#enqueue(async () => {
      validateImConfig(snapshot);
      const key = imBotIdentity(snapshot);
      const current = this.#endpoints.get(key);
      if (!current && this.#endpoints.size >= IM_MAX_BOTS)
        throw new Error("IM_ENDPOINT_CAPACITY_EXHAUSTED");
      if (current) await this.#dispose(current);
      if (this.#closed) throw new Error("IM_MANAGER_CLOSED");
      const endpoint: Endpoint = {};
      // 在后续构造和启动之前登记句柄，初始化异常也能清理；清理失败保留原记录阻止替换。
      this.#endpoints.set(key, endpoint);
      try {
        if (snapshot.enabled !== false && this.dependencies.createSessionStore) {
          const source = this.dependencies.createSessionStore(
            structuredClone(snapshot) as unknown as JsonObject
          );
          endpoint.store = new HostSessionStore(source);
          endpoint.store.validate();
        }
        const runtime = new ImRuntime(snapshot, {
          ...this.dependencies,
          sessions: endpoint.store?.sessions ?? this.dependencies.sessions,
          signal: AbortSignal.any([
            this.#abort.signal,
            ...(this.dependencies.signal ? [this.dependencies.signal] : [])
          ])
        });
        endpoint.runtime = runtime;
        await runtime.start();
        return { ...runtime.status };
      } catch (error) {
        await this.#dispose(endpoint);
        this.#endpoints.delete(key);
        throw error;
      }
    });
  }
  remove(id: string): Promise<void> {
    return this.#enqueue(async () => {
      const endpoint = this.#endpoints.get(id);
      if (endpoint) await this.#dispose(endpoint);
      this.#endpoints.delete(id);
    });
  }
  #dispose(endpoint: Endpoint): Promise<void> {
    if (endpoint.closing) return endpoint.closing;
    endpoint.store?.beginDrain();
    // 与 Extra 共享 5 秒上限；内部 remove/upsert 也必须有界，不能等待永不退出的 Provider。
    // 超时只撤销访问，不冒充资源释放，也不允许替代实例覆盖失败记录。
    const operation = Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      try {
        await endpoint.runtime?.close();
      } catch (error) {
        errors.push(error);
      }
      try {
        await endpoint.store?.close();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "IM_DISPOSE_FAILED");
    });
    endpoint.closing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        endpoint.store?.revoke();
        reject(new Error("IM_DISPOSE_FAILED"));
      }, 5_000);
      void operation.then(resolve, reject).finally(() => clearTimeout(timer));
    });
    return endpoint.closing;
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("IM_MANAGER_CLOSED"));
    if (this.#operations >= IM_MAX_CONFIG_OPERATIONS)
      return Promise.reject(new Error("IM_CONFIG_QUEUE_CAPACITY_EXHAUSTED"));
    this.#operations++;
    const task = this.#queue
      .then(() => {
        if (this.#closed) throw new Error("IM_MANAGER_CLOSED");
        return operation();
      })
      .finally(() => {
        this.#operations--;
      });
    this.#queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#detachOwner?.();
    this.#detachOwner = undefined;
    // Cancel initialization before waiting for the queue it is blocking.
    this.#abort.abort();
    this.#closing = this.#closeAll();
    return this.#closing;
  }
  async #closeAll(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const operation = (async () => {
      // 先开始清理已创建实例，不能等到不合作的初始化退出才撤销存储访问。
      const results = await Promise.allSettled(
        [...this.#endpoints.values()].map((endpoint) => this.#dispose(endpoint))
      );
      await this.#queue;
      const errors = results
        .filter((result) => result.status === "rejected")
        .map((result): unknown => result.reason);
      if (errors.length) throw new AggregateError(errors, "IM_DISPOSE_FAILED");
      this.#endpoints.clear();
    })();
    try {
      await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            for (const endpoint of this.#endpoints.values()) endpoint.store?.revoke();
            reject(new Error("IM_DISPOSE_FAILED"));
          }, 5_000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
