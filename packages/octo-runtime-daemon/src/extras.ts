import type { HostRunService } from "@mininglamp-oss/octo-runtime-adapter-host";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type ExtraDisposer = () => void | Promise<void>;

/** This execution environment is unrelated to the model Context envelope. */
export interface ExtraContext {
  readonly adapterHost: Pick<HostRunService, "invoke" | "cancel" | "respondInteraction">;
  readonly signal: AbortSignal;
  onDispose(dispose: ExtraDisposer): void;
}

export type ExtraPlugin = (context: ExtraContext, config: JsonObject) => void | Promise<void>;
export interface ExtraPluginModule {
  name: string;
  default: ExtraPlugin;
}
export interface ExtraRegistration {
  name: string;
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

  load(name: string): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("EXTRA_LOADER_CLOSED"));
    const registration = this.#registrations.get(name);
    if (!registration) return Promise.reject(new Error("EXTRA_NOT_REGISTERED"));
    if (this.#instances.has(name)) return Promise.reject(new Error("EXTRA_ALREADY_LOADED"));
    const instance: ExtraInstance = {
      controller: new AbortController(),
      disposers: [],
      starting: Promise.resolve(),
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
          error instanceof Error && /^EXTRA_[A-Z_]+$/.test(error.message)
            ? error.message
            : "EXTRA_LOAD_FAILED";
        this.#statuses.set(name, {
          phase: "error",
          error: cleanupFailed ? "EXTRA_DISPOSE_FAILED" : code
        });
        if (!instance.disposing) this.#instances.delete(name);
        throw error;
      }
    });
    return instance.starting;
  }

  unload(name: string): Promise<void> {
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
        this.#instances.delete(name);
      }
    })();
    return instance.disposing;
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
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
