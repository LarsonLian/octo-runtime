import type { ImBotConfig } from "../contracts.js";
import type { ImModuleDependencies } from "../ports.js";
import { ImRuntime } from "../application/im-channel.js";
import { imBotIdentity, validateImConfig } from "./configuration.js";

/** Serial updates replace only the target connection. */
export class ImChannelManager {
  readonly #endpoints = new Map<string, ImRuntime>();
  #queue: Promise<void> = Promise.resolve();
  #closed = false;
  constructor(readonly dependencies: ImModuleDependencies) {}
  get status(): Record<string, unknown>[] {
    return [...this.#endpoints.values()].map((runtime) => ({ ...runtime.status }));
  }
  upsert(config: ImBotConfig): Promise<Record<string, unknown>> {
    const snapshot = structuredClone(config);
    return this.#enqueue(async () => {
      validateImConfig(snapshot);
      const key = imBotIdentity(snapshot);
      const current = this.#endpoints.get(key);
      if (!current && this.#endpoints.size >= 16) throw new Error("IM_ENDPOINT_CAPACITY_EXHAUSTED");
      const runtime = new ImRuntime(snapshot, this.dependencies);
      await current?.close();
      this.#endpoints.set(key, runtime);
      await runtime.start();
      return { ...runtime.status };
    });
  }
  remove(id: string): Promise<void> {
    return this.#enqueue(async () => {
      await this.#endpoints.get(id)?.close();
      this.#endpoints.delete(id);
    });
  }
  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#queue.then(() => {
      if (this.#closed) throw new Error("IM_MANAGER_CLOSED");
      return operation();
    });
    this.#queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#queue;
    await Promise.allSettled([...this.#endpoints.values()].map((runtime) => runtime.close()));
    this.#endpoints.clear();
  }
}
