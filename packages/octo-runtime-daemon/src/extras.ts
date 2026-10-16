import type { InputInvoke, InteractionResponse } from "@mininglamp-oss/octo-runtime-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-runtime-adapter-host";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type ExtraDisposer = () => void | Promise<void>;
export type ExtraStatusHandler = () => JsonObject;

/** 插件复用宿主执行实例，不依赖 HostRunService 的内部实现。 */
export interface ExtraAdapterHost {
  list?(): Promise<HostedAdapterMetadata[]>;
  invoke: InputInvoke;
  cancel(invocationId: string, reason?: string): Promise<{ cancelled: boolean }>;
  respondInteraction(invocationId: string, response: InteractionResponse): Promise<void>;
}

/** This execution environment is unrelated to the model Context envelope. */
export interface ExtraContext {
  readonly adapterHost: ExtraAdapterHost;
  readonly signal: AbortSignal;
  onDispose(dispose: ExtraDisposer): void;
  onStatus(handler: ExtraStatusHandler): void;
}

export type ExtraPlugin = (context: ExtraContext, config: JsonObject) => void | Promise<void>;
export interface ExtraPluginModule {
  name: string;
  default: ExtraPlugin;
}
export interface ExtraRegistration {
  name: string;
  module?: string;
  load(): Promise<ExtraPluginModule>;
  config: JsonObject;
  enabled?: boolean;
}
export interface ExtraStatus {
  phase: "disabled" | "loading" | "loaded" | "disposing" | "disposed" | "error";
  error?: string;
}
interface ExtraInstance {
  controller: AbortController;
  disposers: ExtraDisposer[];
  starting: Promise<void>;
  disposing?: Promise<void>;
  sealed: boolean;
  disposalError?: AggregateError;
  status: ExtraStatusHandler;
  statusRegistered: boolean;
}

export function assertExtraName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new Error("EXTRA_NAME_INVALID");
}

/** One scoped instance per declared name. Only HostApp-selected entries load. */
export class ExtraPlugins {
  readonly #registrations = new Map<string, ExtraRegistration>();
  readonly #instances = new Map<string, ExtraInstance>();
  readonly #statuses = new Map<string, ExtraStatus>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #loadEpochs = new Map<string, number>();

  static validate(registrations: readonly ExtraRegistration[]): void {
    const names = new Set<string>();
    for (const entry of registrations) {
      assertExtraName(entry.name);
      if (names.has(entry.name)) throw new Error("EXTRA_NAME_DUPLICATED");
      if (typeof entry.load !== "function") throw new Error("EXTRA_LOADER_MISSING");
      names.add(entry.name);
    }
  }

  constructor(
    registrations: readonly ExtraRegistration[],
    private readonly adapterHost: ExtraContext["adapterHost"]
  ) {
    ExtraPlugins.validate(registrations);
    for (const registration of registrations) {
      this.#registrations.set(registration.name, registration);
      this.#statuses.set(registration.name, { phase: "disabled" });
    }
  }

  get status(): Record<string, ExtraStatus> {
    return Object.fromEntries([...this.#statuses].map(([name, status]) => [name, { ...status }]));
  }

  async loadConfigured(): Promise<void> {
    await Promise.allSettled(
      [...this.#registrations.values()]
        .filter((entry) => entry.enabled !== false)
        .map((entry) => this.load(entry.name))
    );
  }

  inspect(name: string): Promise<JsonObject> {
    assertExtraName(name);
    return this.#serial(name, async () => {
      const instance = this.#instances.get(name);
      if (!instance || instance.controller.signal.aborted) throw new Error("EXTRA_NOT_LOADED");
      await instance.starting;
      instance.controller.signal.throwIfAborted();
      try {
        const value = instance.status();
        assertStatusObject(value);
        return structuredClone(value);
      } catch {
        throw new Error("EXTRA_STATUS_FAILED");
      }
    });
  }

  #serial<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.#queues.get(name) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.#queues.set(name, task);
    void task.finally(() => { if (this.#queues.get(name) === task) this.#queues.delete(name); }).catch(() => undefined);
    return task;
  }

  load(name: string, registration?: ExtraRegistration): Promise<void> {
    assertExtraName(name);
    const epoch = this.#loadEpochs.get(name) ?? 0;
    return this.#serial(name, () => {
      if (registration) {
        ExtraPlugins.validate([registration]);
        if (registration.name !== name) throw new Error("EXTRA_NAME_MISMATCH");
        if (this.#closed) throw new Error("EXTRA_LOADER_CLOSED");
        if (epoch !== (this.#loadEpochs.get(name) ?? 0)) throw new Error("EXTRA_LOAD_CANCELLED");
        if (this.#instances.has(name)) throw new Error("EXTRA_ALREADY_LOADED");
        this.#registrations.set(name, registration);
      }
      return this.#load(name, epoch);
    });
  }

  #load(name: string, epoch: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("EXTRA_LOADER_CLOSED"));
    if (epoch !== (this.#loadEpochs.get(name) ?? 0)) return Promise.reject(new Error("EXTRA_LOAD_CANCELLED"));
    const registration = this.#registrations.get(name);
    if (!registration) return Promise.reject(new Error("EXTRA_NOT_REGISTERED"));
    if (this.#instances.has(name)) return Promise.reject(new Error("EXTRA_ALREADY_LOADED"));
    const instance: ExtraInstance = {
      controller: new AbortController(),
      disposers: [],
      starting: Promise.resolve(),
      status: () => ({}),
      statusRegistered: false,
      sealed: false
    };
    this.#instances.set(name, instance);
    this.#statuses.set(name, { phase: "loading" });
    instance.starting = Promise.resolve().then(async () => {
      try {
        const plugin = await registration.load();
        if (plugin.name !== name) throw new Error("EXTRA_NAME_MISMATCH");
        if (typeof plugin.default !== "function") throw new Error("EXTRA_LAMBDA_MISSING");
        instance.controller.signal.throwIfAborted();
        await plugin.default(
          {
            adapterHost: this.adapterHost,
            signal: instance.controller.signal,
            onDispose(dispose) {
              if (instance.sealed) throw new Error("EXTRA_ALREADY_DISPOSED");
              if (typeof dispose !== "function") throw new Error("EXTRA_DISPOSER_INVALID");
              instance.disposers.push(dispose);
            },
            onStatus(handler) {
              if (instance.sealed || instance.statusRegistered || typeof handler !== "function") throw new Error("EXTRA_STATUS_HANDLER_INVALID");
              instance.status = handler;
              instance.statusRegistered = true;
            }
          },
          structuredClone(registration.config)
        );
        if (!instance.controller.signal.aborted) this.#statuses.set(name, { phase: "loaded" });
      } catch (error) {
        instance.controller.abort();
        let cleanupFailed = false;
        await this.#dispose(instance).catch(() => {
          cleanupFailed = true;
        });
        // Never copy third-party error text or configuration secrets into public status.
        const code =
          error instanceof Error && /^(?:EXTRA|IM|WECOM)_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND"
              ? "EXTRA_MODULE_NOT_FOUND"
            : "EXTRA_LOAD_FAILED";
        this.#statuses.set(name, {
          phase: "error",
          error: cleanupFailed ? "EXTRA_DISPOSE_FAILED" : code
        });
        if (!instance.disposing && !instance.disposalError) this.#instances.delete(name);
        throw error;
      }
    });
    return instance.starting;
  }

  unload(name: string): Promise<void> {
    // Cancel queued initialization even when its AbortController does not exist yet.
    this.#loadEpochs.set(name, (this.#loadEpochs.get(name) ?? 0) + 1);
    this.#instances.get(name)?.controller.abort();
    return this.#serial(name, () => this.#unload(name));
  }

  #unload(name: string): Promise<void> {
    const instance = this.#instances.get(name);
    if (!instance) return Promise.resolve();
    if (instance.disposing) return instance.disposing;
    instance.controller.abort();
    this.#statuses.set(name, { phase: "disposing" });
    instance.disposing = (async () => {
      await instance.starting.catch(() => undefined);
      try {
        await this.#dispose(instance);
        this.#statuses.set(name, { phase: "disposed" });
      } catch (error) {
        this.#statuses.set(name, { phase: "error", error: "EXTRA_DISPOSE_FAILED" });
        throw error;
      } finally {
        if (!instance.disposalError) this.#instances.delete(name);
      }
    })();
    return instance.disposing;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const instance of this.#instances.values()) instance.controller.abort();
    this.#closing = (async () => {
      const results = await Promise.allSettled(
        [...this.#instances.keys()].reverse().map((name) => this.unload(name))
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason as unknown),
          "EXTRA_DISPOSE_FAILED"
        );
    })();
    return this.#closing;
  }

  async #dispose(instance: ExtraInstance): Promise<void> {
    if (instance.sealed) {
      if (instance.disposalError) throw instance.disposalError;
      return;
    }
    instance.sealed = true;
    const errors: unknown[] = [];
    for (const dispose of instance.disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    instance.disposers.length = 0;
    if (errors.length) {
      instance.disposalError = new AggregateError(errors, "EXTRA_DISPOSE_FAILED");
      throw instance.disposalError;
    }
  }
}

function assertStatusObject(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("EXTRA_STATUS_JSON_REQUIRED");
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || seen.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype))
      throw new Error("EXTRA_STATUS_JSON_REQUIRED");
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
}
