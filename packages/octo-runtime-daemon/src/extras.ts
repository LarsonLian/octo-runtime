import type { InputInvoke, InteractionResponse } from "@mininglamp-oss/octo-runtime-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-runtime-adapter-host";
import { noopRuntimeLog, type RuntimeLog } from "@mininglamp-oss/octo-runtime-adapter-sdk";
export type { ChannelDependencies, LoadContexts } from "./context-loader.js";
export type { RuntimeLog, RuntimeLogLevel } from "@mininglamp-oss/octo-runtime-adapter-sdk";

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
  /** F31：.octospec/tasks/gateway-august-feature-assessment/assessment.md；无日志宿主也提供 no-op。 */
  readonly log: RuntimeLog;
  readonly adapterHost: ExtraAdapterHost;
  readonly signal: AbortSignal;
  onDispose(dispose: ExtraDisposer): void;
  onStatus(handler: ExtraStatusHandler): void;
}

/** 第二阶段接收同进程业务函数，允许异步启动；返回完成只代表初始化完成，不代表卸载。 */
export type ExtraInitializer<D extends object = Record<string, never>> = (
  dependencies: Readonly<D>
) => void | Promise<void>;
/** 第一阶段必须同步返回 initializer；JSON 配置与不可序列化的业务函数依赖始终分开。 */
export type ExtraPlugin<D extends object = Record<string, never>> = (
  context: ExtraContext,
  config: JsonObject
) => ExtraInitializer<D>;
export interface ExtraPluginModule<D extends object = Record<string, never>> {
  name: string;
  default: ExtraPlugin<D>;
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
  cleanup?: Promise<void>;
  status: ExtraStatusHandler;
  statusRegistered: boolean;
}

export function assertExtraName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
    throw new Error("EXTRA_NAME_INVALID");
}

/** 每个声明名最多一个实例；只加载宿主选定的插件，并统一管理取消、状态和清理。 */
export class ExtraPlugins {
  readonly #registrations = new Map<string, ExtraRegistration>();
  readonly #instances = new Map<string, ExtraInstance>();
  readonly #statuses = new Map<string, ExtraStatus>();
  #closed = false;
  #closing?: Promise<void>;
  readonly #queues = new Map<string, Promise<unknown>>();
  readonly #loadEpochs = new Map<string, number>();
  readonly #unloading = new Map<string, Promise<void>>();
  #pendingLoads = 0;

  static validate(registrations: readonly ExtraRegistration[]): void {
    if (registrations.length > 64) throw new Error("EXTRA_CAPACITY_EXHAUSTED");
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
    private readonly adapterHost: ExtraContext["adapterHost"],
    private readonly logForExtra: (name: string) => RuntimeLog = () => noopRuntimeLog
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

  // 同名操作串行，失败不阻断后续操作；队尾结束后移除引用，避免保留已完成的任务链。
  #serial<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.#queues.get(name) ?? Promise.resolve())
      .catch(() => undefined)
      .then(operation);
    this.#queues.set(name, task);
    void task
      .finally(() => {
        if (this.#queues.get(name) === task) this.#queues.delete(name);
        if (!this.#statuses.has(name) && !this.#queues.has(name) && !this.#unloading.has(name))
          this.#loadEpochs.delete(name);
      })
      .catch(() => undefined);
    return task;
  }

  load<D extends object>(
    module: ExtraPluginModule<D>,
    config: JsonObject,
    dependencies: Readonly<D>
  ): Promise<void>;
  load(name: string, registration?: ExtraRegistration): Promise<void>;
  load<D extends object>(
    target: string | ExtraPluginModule<D>,
    configOrRegistration?: JsonObject | ExtraRegistration,
    dependencies?: Readonly<D>
  ): Promise<void> {
    if (typeof target !== "string") {
      // 仅在同一 Node 进程闭包捕获函数；复用下方生命周期，不把函数写入声明或传过 IPC。
      const functions = Object.freeze({ ...dependencies }) as Readonly<D>;
      const registration: ExtraRegistration = {
        name: target.name,
        config: configOrRegistration as JsonObject,
        load: () =>
          Promise.resolve({
            name: target.name,
            default: (context, config) => {
              const initialize = target.default(context, config);
              if (typeof initialize !== "function") {
                void Promise.resolve(initialize).catch(() => undefined);
                throw new Error("EXTRA_INITIALIZER_REQUIRED");
              }
              return () => initialize(functions);
            }
          })
      };
      return this.load(target.name, registration).finally(() => {
        // 此声明只服务本次装配；释放宿主闭包。下次加载必须由宿主重新提供依赖。
        if (this.#registrations.get(target.name) === registration)
          this.#registrations.delete(target.name);
      });
    }
    const name = target;
    const registration = configOrRegistration as ExtraRegistration | undefined;
    assertExtraName(name);
    if (this.#closed) return Promise.reject(new Error("EXTRA_LOADER_CLOSED"));
    if (this.#pendingLoads >= 64) return Promise.reject(new Error("EXTRA_LOAD_QUEUE_FULL"));
    if (!this.#statuses.has(name) && this.#statuses.size >= 64)
      return Promise.reject(new Error("EXTRA_CAPACITY_EXHAUSTED"));
    this.#pendingLoads++;
    const epoch = this.#loadEpochs.get(name) ?? 0;
    const unloading = this.#unloading.get(name);
    return this.#serial(name, async () => {
      // 正在卸载时必须等清理成功；清理失败直接拒绝替换，不能借重载绕过挂起资源。
      if (unloading) await unloading;
      if (registration) {
        ExtraPlugins.validate([registration]);
        if (registration.name !== name) throw new Error("EXTRA_NAME_MISMATCH");
        if (this.#closed) throw new Error("EXTRA_LOADER_CLOSED");
        if (epoch !== (this.#loadEpochs.get(name) ?? 0)) throw new Error("EXTRA_LOAD_CANCELLED");
        if (this.#instances.has(name)) throw new Error("EXTRA_ALREADY_LOADED");
        this.#registrations.set(name, registration);
      }
      return this.#load(name, epoch);
    }).finally(() => {
      this.#pendingLoads--;
    });
  }

  #load(name: string, epoch: number): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("EXTRA_LOADER_CLOSED"));
    if (epoch !== (this.#loadEpochs.get(name) ?? 0))
      return Promise.reject(new Error("EXTRA_LOAD_CANCELLED"));
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
        assertStatusObject(registration.config);
        instance.controller.signal.throwIfAborted();
        const initialize = plugin.default(
          {
            adapterHost: this.adapterHost,
            log: (level, event, data) => {
              try {
                this.logForExtra(name)(level, event, data);
              } catch {
                /* 宿主 logger 不影响插件。 */
              }
            },
            signal: instance.controller.signal,
            onDispose(dispose) {
              if (instance.sealed) throw new Error("EXTRA_ALREADY_DISPOSED");
              if (typeof dispose !== "function") throw new Error("EXTRA_DISPOSER_INVALID");
              instance.disposers.push(dispose);
            },
            onStatus(handler) {
              if (instance.sealed || instance.statusRegistered || typeof handler !== "function")
                throw new Error("EXTRA_STATUS_HANDLER_INVALID");
              instance.status = handler;
              instance.statusRegistered = true;
            }
          },
          structuredClone(registration.config)
        );
        if (typeof initialize !== "function") {
          // 拒绝旧 ABI，同时消费旧 async 入口可能产生的拒绝，不把它当作初始化成功。
          void Promise.resolve(initialize).catch(() => undefined);
          throw new Error("EXTRA_INITIALIZER_REQUIRED");
        }
        instance.controller.signal.throwIfAborted();
        // JSON 声明入口没有业务函数；同进程装配的包装函数会传入本次绑定的依赖。
        await initialize(Object.freeze({}));
        instance.controller.signal.throwIfAborted();
        this.#statuses.set(name, { phase: "loaded" });
      } catch (error) {
        instance.controller.abort();
        let cleanupFailed = false;
        await withDisposalDeadline(this.#dispose(instance)).catch((cleanupError: unknown) => {
          cleanupFailed = true;
          instance.disposalError ??= new AggregateError([cleanupError], "EXTRA_DISPOSE_FAILED");
        });
        // 对外只保留稳定错误码，避免第三方错误正文携带配置或凭据。
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
    assertExtraName(name);
    const unloading = this.#unloading.get(name);
    if (unloading) return unloading;
    if (!this.#registrations.has(name) && !this.#instances.has(name) && !this.#queues.has(name))
      return Promise.resolve();
    // 递增代次也能撤销尚未创建 AbortController 的排队 load，防止卸载后又启动旧声明。
    this.#loadEpochs.set(name, (this.#loadEpochs.get(name) ?? 0) + 1);
    this.#instances.get(name)?.controller.abort();
    const instance = this.#instances.get(name);
    // abort 不能排在初始化 Promise 后面；外部初始化可能正等待这个取消信号才会退出。
    const task = instance ? this.#unload(name) : this.#serial(name, () => this.#unload(name));
    this.#unloading.set(name, task);
    void task
      .finally(() => {
        if (this.#unloading.get(name) === task) this.#unloading.delete(name);
        if (!this.#statuses.has(name) && !this.#queues.has(name)) this.#loadEpochs.delete(name);
      })
      .catch(() => undefined);
    return task;
  }

  #unload(name: string): Promise<void> {
    const instance = this.#instances.get(name);
    if (!instance) return Promise.resolve();
    if (instance.disposing) return instance.disposing;
    instance.controller.abort();
    this.#statuses.set(name, { phase: "disposing" });
    instance.disposing = (async () => {
      try {
        await withDisposalDeadline(
          (async () => {
            await instance.starting.catch(() => undefined);
            await this.#dispose(instance);
          })()
        );
        this.#statuses.set(name, { phase: "disposed" });
      } catch (error) {
        this.#statuses.set(name, { phase: "error", error: "EXTRA_DISPOSE_FAILED" });
        throw error;
      } finally {
        // 只有完整清理成功才允许释放实例；超时不是资源已释放的证据，失败实例必须阻止重载。
        if (!instance.disposalError && this.#statuses.get(name)?.phase === "disposed")
          this.#instances.delete(name);
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
    // 初始化失败、主动卸载和整体关闭可能并发到达；所有路径共用一次清理过程。
    if (instance.cleanup) return instance.cleanup;
    if (instance.sealed) {
      if (instance.disposalError) throw instance.disposalError;
      return;
    }
    instance.sealed = true;
    // 状态回调通常闭包引用整个业务服务，清理开始即解除该引用，禁止再登记资源。
    instance.status = () => ({});
    instance.cleanup = (async () => {
      const errors: unknown[] = [];
      // 逆序匹配资源的创建依赖；所有 disposer 共用宽限，单项失败仍继续尝试其余清理。
      const deadline = Date.now() + 5_000;
      for (const dispose of instance.disposers.reverse()) {
        try {
          const operation = Promise.resolve().then(dispose);
          await withDisposalDeadline(operation, Math.max(1, deadline - Date.now()));
        } catch (error) {
          errors.push(error);
        }
      }
      instance.disposers.length = 0;
      if (errors.length) {
        instance.disposalError = new AggregateError(errors, "EXTRA_DISPOSE_FAILED");
        throw instance.disposalError;
      }
    })();
    return instance.cleanup;
  }
}

async function withDisposalDeadline(operation: Promise<void>, timeoutMs = 5_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("EXTRA_DISPOSE_FAILED")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function assertStatusObject(value: unknown): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("EXTRA_STATUS_JSON_REQUIRED");
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (
      !item ||
      typeof item !== "object" ||
      seen.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)
    )
      throw new Error("EXTRA_STATUS_JSON_REQUIRED");
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
}
