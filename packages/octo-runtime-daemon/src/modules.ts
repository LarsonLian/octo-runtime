import type { HostRunService } from "@mininglamp-oss/octo-runtime-adapter-host";
import { noopRuntimeLog, type RuntimeLog } from "@mininglamp-oss/octo-runtime-adapter-sdk";

export interface DaemonModuleContext {
  log?: RuntimeLog;
  host: HostRunService;
  homePath: string;
  signal: AbortSignal;
  account?: {
    subject: { type: "user"; id: string };
    profiles: Array<{ tenantId: string; profile: string; runtimeId: string; root: string }>;
    machineId: string;
  };
}

export interface DaemonModule {
  readonly status: unknown;
  start(): Promise<void>;
  handle?(request: { method: string; params?: Record<string, unknown> }): Promise<unknown>;
  beginDrain?(): void;
  waitForDrained?(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

export interface DaemonModuleRegistration {
  id: string;
  create(context: DaemonModuleContext, config: unknown): DaemonModule | Promise<DaemonModule>;
  /** Only an explicit config enables a module at daemon startup. */
  config?: unknown;
}

interface ActiveModule {
  controller: AbortController;
  phase: "starting" | "running" | "error";
  instance?: DaemonModule;
  starting: Promise<void>;
  error?: string;
}

export class DaemonModules {
  readonly #registrations = new Map<string, DaemonModuleRegistration>();
  readonly #active = new Map<string, ActiveModule>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;
  #draining = false;

  static validate(registrations: readonly DaemonModuleRegistration[]): void {
    const ids = new Set<string>();
    for (const registration of registrations) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(registration.id) || ids.has(registration.id))
        throw new Error("DAEMON_MODULE_ID_INVALID");
      if (typeof registration.create !== "function")
        throw new Error("DAEMON_MODULE_FACTORY_MISSING");
      ids.add(registration.id);
    }
  }

  constructor(
    registrations: readonly DaemonModuleRegistration[],
    private readonly context: Omit<DaemonModuleContext, "signal">,
    private readonly logForModule: (name: string) => RuntimeLog = () => noopRuntimeLog
  ) {
    DaemonModules.validate(registrations);
    for (const registration of registrations) {
      this.#registrations.set(registration.id, registration);
    }
  }

  get status(): Record<string, unknown> {
    return Object.fromEntries(
      [...this.#registrations.keys()].map((id) => {
        const active = this.#active.get(id);
        return [
          id,
          active
            ? {
                phase: active.phase,
                ...(active.error ? { error: active.error } : {}),
                state: active.instance?.status
              }
            : { phase: "disabled" }
        ];
      })
    );
  }

  startConfigured(): void {
    for (const entry of this.#registrations.values())
      if (entry.config !== undefined)
        void this.start(entry.id, entry.config).catch(() => undefined);
  }

  start(id: string, config: unknown): Promise<unknown> {
    return this.#serial(async () => {
      if (this.#closed || this.#draining) throw new Error("DAEMON_STOPPING");
      const registration = this.#registrations.get(id);
      if (!registration) throw new Error("DAEMON_MODULE_NOT_AVAILABLE");
      await this.#stop(id);
      const active: ActiveModule = {
        controller: new AbortController(),
        phase: "starting",
        starting: Promise.resolve()
      };
      this.#active.set(id, active);
      active.starting = (async () => {
        try {
          const instance = await registration.create(
            { ...this.context, signal: active.controller.signal, log: this.logForModule(id) },
            config
          );
          active.instance = instance;
          if (active.controller.signal.aborted) {
            await instance.close();
            return;
          }
          await instance.start();
          if (!active.controller.signal.aborted) active.phase = "running";
        } catch (error) {
          await active.instance?.close().catch(() => undefined);
          if (!active.controller.signal.aborted) {
            active.phase = "error";
            // Modules own their error messages; credentials must never be included.
            active.error = error instanceof Error ? error.message : "DAEMON_MODULE_START_FAILED";
          }
        }
      })();
      return this.status[id];
    });
  }

  stop(id: string): Promise<void> {
    return this.#serial(() => this.#stop(id));
  }

  async request(
    id: string,
    request: { method: string; params?: Record<string, unknown> }
  ): Promise<unknown> {
    const active = this.#active.get(id);
    if (!active) throw new Error("DAEMON_MODULE_NOT_RUNNING");
    await active.starting;
    if (active.controller.signal.aborted || this.#active.get(id) !== active)
      throw new Error("DAEMON_MODULE_STOPPED");
    if (active.phase === "error") throw new Error(active.error);
    if (!active.instance?.handle) throw new Error("DAEMON_MODULE_METHOD_NOT_FOUND");
    return active.instance.handle(request);
  }

  async drain(timeoutMs: number): Promise<void> {
    this.#draining = true;
    for (const active of this.#active.values()) {
      if (active.phase === "starting") active.controller.abort();
      active.instance?.beginDrain?.();
    }
    await Promise.all(
      [...this.#active.values()].map(async (active) => {
        await active.instance?.waitForDrained?.(timeoutMs);
      })
    );
  }

  close(): Promise<void> {
    this.#closed = true;
    // Abort immediately, including an enrollment still pending in a factory.
    for (const active of this.#active.values()) active.controller.abort();
    return this.#serial(async () => {
      for (const id of [...this.#active.keys()]) await this.#stop(id);
    });
  }

  async #stop(id: string): Promise<void> {
    const active = this.#active.get(id);
    if (!active) return;
    active.controller.abort();
    await active.instance?.close();
    await active.starting;
    await active.instance?.close();
    this.#active.delete(id);
  }

  #serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
