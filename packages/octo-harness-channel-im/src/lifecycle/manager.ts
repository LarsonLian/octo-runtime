/**
 * 动态接入管理：无需重启 Daemon 即可新增、更新或移除 Bot，仅替换目标连接。
 * 串行处理配置代次并保留删除记录，阻止迟到的旧配置重新启用已移除账号。
 */
import type { ImBotConfig } from "../contracts.js";
import type { ImModuleDependencies } from "../ports.js";
import { ImRuntime } from "../application/im-channel.js";
import { imBotIdentity, validateImConfig } from "./configuration.js";

export class ImChannelManager {
  readonly #endpoints = new Map<string, { revision: number; runtime: ImRuntime }>();
  // 删除后仍保留代次墓碑，拒绝延迟到达的旧 upsert。
  readonly #revisions = new Map<string, number>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(readonly dependencies: ImModuleDependencies) {}
  get status(): Record<string, unknown>[] {
    return [...this.#endpoints.values()].map((endpoint) => ({
      ...endpoint.runtime.status,
      revision: endpoint.revision
    }));
  }
  upsert(config: ImBotConfig, revision: number): Promise<Record<string, unknown>> {
    const snapshot = structuredClone(config);
    return this.#enqueue(async () => {
      validateImConfig(snapshot);
      this.#validateRevision(snapshot.id, revision);
      const current = this.#endpoints.get(snapshot.id);
      if (revision === current?.revision) {
        if (configurationKey(snapshot) !== configurationKey(current.runtime.config))
          throw new Error("IM_REVISION_CONFLICT");
        return { ...current.runtime.status, revision };
      }
      for (const [id, endpoint] of this.#endpoints)
        if (
          id !== snapshot.id &&
          imBotIdentity(endpoint.runtime.config) === imBotIdentity(snapshot)
        )
          throw new Error("IM_BOT_DUPLICATED");
      if (!current && this.#endpoints.size >= 16) throw new Error("IM_ENDPOINT_CAPACITY_EXHAUSTED");
      const runtime = new ImRuntime(snapshot, this.dependencies);
      // 先关闭旧实例再启新实例，避免同一 Bot 同时拥有两条收消息连接。
      await current?.runtime.close();
      this.#endpoints.set(snapshot.id, { runtime, revision });
      this.#revisions.set(snapshot.id, revision);
      await runtime.start();
      return { ...runtime.status, revision };
    });
  }
  remove(id: string, revision: number): Promise<void> {
    return this.#enqueue(async () => {
      if (
        !this.#endpoints.has(id) &&
        Number.isSafeInteger(revision) &&
        revision > 0 &&
        this.#revisions.get(id) === revision
      )
        return;
      this.#validateRevision(id, revision);
      const current = this.#endpoints.get(id);
      if (current && revision <= current.revision) throw new Error("IM_CONFIG_STALE");
      await current?.runtime.close();
      this.#endpoints.delete(id);
      this.#revisions.set(id, revision);
    });
  }
  #validateRevision(id: string, revision: number): void {
    if (!id || !Number.isSafeInteger(revision) || revision < 1)
      throw new Error("IM_CONFIG_INVALID");
    if (!this.#revisions.has(id) && this.#revisions.size >= 4096)
      throw new Error("IM_REGISTRATION_CAPACITY_EXHAUSTED");
    if (
      revision < (this.#revisions.get(id) ?? 0) ||
      (!this.#endpoints.has(id) && revision === this.#revisions.get(id))
    )
      throw new Error("IM_CONFIG_STALE");
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#queue.then(() => {
      if (this.#closed) throw new Error("IM_MANAGER_CLOSED");
      return operation();
    });
    // 单次失败反馈给调用方，但不阻断后续配置操作。
    this.#queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    await Promise.allSettled([...this.#endpoints.values()].map((e) => e.runtime.close()));
    this.#endpoints.clear();
    this.#revisions.clear();
  }
}

function configurationKey(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, sort(entry)])
      );
    return item;
  };
  return JSON.stringify(sort(value));
}
