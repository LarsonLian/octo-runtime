import {
  createInputInvoke,
  type InvokeInput,
  type InvokeEnvironment
} from "@mininglamp-oss/octo-runtime-protocol";
import { assertRuntimeLogging } from "@mininglamp-oss/octo-runtime-adapter-sdk";
import { assertStoredExtra, extraRegistration, type ExtraDescriptor } from "../extra-config.js";
import {
  assertExtraName,
  type ExtraPluginModule,
  type ExtraStatus,
  type JsonObject
} from "../extras.js";
import { LocalExtras } from "./local-extras.js";
import { subscribeDaemonRun, invokeDaemonRun } from "./run-stream.js";
import { callDaemon } from "./runtime-contract.js";
import {
  type HostFrame,
  type NativeInteractionResponse,
  type InteractionResponse
} from "@mininglamp-oss/octo-runtime-protocol";
import type { HostedAdapterMetadata } from "@mininglamp-oss/octo-runtime-adapter-host";
import { DaemonRuntimeError, asDaemonRuntimeError } from "./errors.js";
import { ensureLocalRuntime } from "./identity.js";
import {
  accountKeyFor,
  accountPaths,
  acquireOwnerLock,
  daemonHomePaths,
  ensureAccount,
  ensureDaemonHome,
  profileNameFor,
  profilePaths,
  type DaemonAccountPaths,
  type DaemonHomePaths,
  type OwnerLock
} from "./home.js";
import {
  runtimeStatus,
  startManagedDaemon,
  stopManagedDaemon,
  type SupervisedRuntime
} from "./supervisor.js";
import type {
  AuthorizedTenant,
  DaemonRuntime,
  DaemonRuntimeOptions,
  DaemonHealth,
  DaemonProblem,
  ProfileHealth,
  StartAccountOptions
} from "./types.js";

interface ActiveAccount {
  input: StartAccountOptions;
  account: DaemonAccountPaths;
  tenantProfiles: Map<string, string>;
  supervised: SupervisedRuntime;
  signature: string;
}

export class NodeDaemonRuntime implements DaemonRuntime {
  readonly invoke = createInputInvoke((input, environment) =>
    this.invokeFrames(input, environment)
  );
  readonly #options: DaemonRuntimeOptions;
  readonly #paths: DaemonHomePaths;
  readonly #extras = new Map<string, ExtraDescriptor>();
  readonly #listeners = new Set<(health: DaemonHealth) => void>();
  #snapshot: DaemonHealth;
  #generation = 0;
  #queue: Promise<void> = Promise.resolve();
  #active?: ActiveAccount;
  #extraEpoch = 0;
  // 主进程实例按账号代次持有；失败清理保留阻塞事实，不能换容器后假装旧函数已退出。
  #localExtras?: LocalExtras;
  #localCleanupFailed = false;
  // 两种装配方式共享名字与容量。函数装配不记入可重放的 JSON 声明，重启后由宿主重新提供。
  readonly #extraLocations = new Map<string, "local" | "remote">();
  #pendingExtraLoads = 0;
  readonly #extraNameEpoch = new Map<string, number>();
  #loadingExtra?: {
    name: string;
    active: ActiveAccount;
    cancelled: boolean;
    finished: boolean;
    settled: Promise<void>;
    interrupt?: Promise<void>;
  };
  #ownerLock?: OwnerLock;
  #abort?: AbortController;
  #pollTimer?: NodeJS.Timeout;

  constructor(options: DaemonRuntimeOptions) {
    assertRuntimeLogging(options.logging);
    if ((options.extras?.length ?? 0) > 64) throw new Error("EXTRA_CAPACITY_EXHAUSTED");
    this.#options = options;
    this.#paths = daemonHomePaths(options.home, options.platform);
    this.#snapshot = emptyHealth(this.#paths.home);
    for (const descriptor of options.extras ?? []) {
      extraRegistration(descriptor);
      if (this.#extras.has(descriptor.name)) throw new Error("EXTRA_NAME_DUPLICATED");
      this.#extras.set(descriptor.name, structuredClone(descriptor));
      this.#extraLocations.set(descriptor.name, "remote");
    }
  }

  startAccount(options: StartAccountOptions): Promise<DaemonHealth> {
    const changing =
      this.#active &&
      this.#active.signature !==
        tenantSignature(
          accountKeyFor(options.subject.type, options.subject.id),
          validateTenants(options.tenants)
        );
    const interrupted = changing ? this.#interruptExtras() : undefined;
    return this.#enqueue(async () => {
      await interrupted;
      return this.#startAccount(options);
    });
  }

  reconcileTenants(tenants: readonly AuthorizedTenant[]): Promise<DaemonHealth> {
    const active = this.#active;
    const changing =
      active &&
      active.signature !==
        tenantSignature(
          accountKeyFor(active.input.subject.type, active.input.subject.id),
          validateTenants(tenants)
        );
    const interrupted = changing ? this.#interruptExtras() : undefined;
    return this.#enqueue(async () => {
      await interrupted;
      if (!this.#active)
        throw new DaemonRuntimeError(
          "ACCOUNT_NOT_RUNNING",
          "daemon",
          false,
          "no embedded account is active"
        );
      return this.#startAccount({ ...this.#active.input, tenants });
    });
  }

  stop(reason: "logout" | "account-switch" | "quit" | "reconfigure" = "quit"): Promise<void> {
    const interrupted = this.#interruptExtras();
    return this.#enqueue(async () => {
      await interrupted;
      return this.#stop(reason);
    });
  }

  health(): DaemonHealth {
    return this.#snapshot;
  }

  loadExtra(descriptor: ExtraDescriptor): Promise<Record<string, ExtraStatus>>;
  loadExtra<D extends object>(
    module: ExtraPluginModule<D>,
    config: JsonObject,
    dependencies: Readonly<D>
  ): Promise<Record<string, ExtraStatus>>;
  // 宿主通过这个入口注入自己的业务读取函数，无需了解 Extra 内部结构；公开用途见 DaemonRuntime。
  // .octospec/tasks/sdk-host-extra-contexts/brief.md：JSON 声明继续远端装配，函数引用仅留在本进程。
  loadExtra<D extends object>(
    target: ExtraDescriptor | ExtraPluginModule<D>,
    config?: JsonObject,
    dependencies?: Readonly<D>
  ): Promise<Record<string, ExtraStatus>> {
    const local = config !== undefined;
    const module = local ? (target as ExtraPluginModule<D>) : undefined;
    const descriptor = local ? undefined : (target as ExtraDescriptor);
    assertExtraName(target.name);
    if (module) {
      if (typeof module.default !== "function") throw new Error("EXTRA_LAMBDA_MISSING");
      // 复用 JSON 校验，但函数依赖只作浅复制，绝不 structuredClone 或发过 IPC。
      assertStoredExtra({ module: "sdk-local-extra", config });
    } else extraRegistration(descriptor!);
    const snapshot = descriptor ? structuredClone({ ...descriptor, enabled: true }) : undefined;
    const json = local ? structuredClone(config) : undefined;
    const functions = local ? (Object.freeze({ ...dependencies }) as Readonly<D>) : undefined;
    const selectedModule = module ? { name: module.name, default: module.default } : undefined;
    const name = target.name;
    if (this.#pendingExtraLoads >= 64) return Promise.reject(new Error("EXTRA_LOAD_QUEUE_FULL"));
    this.#pendingExtraLoads++;
    const epoch = this.#extraEpoch;
    const nameEpoch = this.#extraNameEpoch.get(name);
    return this.#enqueue(async () => {
      if (epoch !== this.#extraEpoch || nameEpoch !== this.#extraNameEpoch.get(name)) {
        throw new Error("EXTRA_LOAD_CANCELLED");
      }
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      if (this.#localCleanupFailed) throw new Error("EXTRA_DISPOSE_FAILED");
      if (!this.#snapshot.local.adapterHostReady) throw new Error("HOST_NOT_READY");
      const status = await this.#extraControl("extra.status", {});
      if (epoch !== this.#extraEpoch || nameEpoch !== this.#extraNameEpoch.get(name))
        throw new Error("EXTRA_LOAD_CANCELLED");
      const previous = status[name];
      if (previous?.error === "EXTRA_DISPOSE_FAILED") throw new Error("EXTRA_DISPOSE_FAILED");
      if (previous && ["loading", "loaded", "disposing"].includes(previous.phase))
        throw new Error("EXTRA_ALREADY_LOADED");
      const names = new Set([...this.#extras.keys(), ...Object.keys(status)]);
      if (!names.has(name) && names.size >= 64) throw new Error("EXTRA_CAPACITY_EXHAUSTED");
      if (
        this.#options.modules?.some((entry) => entry.id === name) ||
        Object.hasOwn(this.#snapshot.modules, name)
      )
        throw new Error("EXTRA_MODULE_NAME_CONFLICT");
      let finish!: () => void;
      const settled = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const loading = { name, active: this.#active, cancelled: false, finished: false, settled };
      this.#loadingExtra = loading;
      try {
        let result: Record<string, ExtraStatus>;
        if (selectedModule) {
          this.#extraLocations.set(name, "local");
          this.#extras.delete(name);
          const pending = this.#localExtras!.load(selectedModule, json!, functions!);
          this.#emitExtraStatus();
          await pending;
          result = this.#mergeExtraStatus(status);
          this.#emitExtraStatus(result);
        } else {
          this.#extraLocations.set(name, "remote");
          result = await this.#extraControl("extra.load", { descriptor: snapshot });
        }
        if (loading.cancelled) throw new Error("EXTRA_LOAD_CANCELLED");
        if (snapshot) this.#extras.set(name, snapshot);
        return result;
      } catch (error) {
        if (this.#localExtras?.plugins.status[name]?.error === "EXTRA_DISPOSE_FAILED")
          throw new Error("EXTRA_DISPOSE_FAILED", { cause: error });
        if (
          loading.cancelled &&
          !(error instanceof Error && error.message === "EXTRA_DISPOSE_FAILED")
        ) {
          throw new Error("EXTRA_LOAD_CANCELLED", { cause: error });
        }
        throw error;
      } finally {
        this.#emitExtraStatus();
        loading.finished = true;
        finish();
        if (this.#loadingExtra === loading) this.#loadingExtra = undefined;
      }
    }).finally(() => {
      this.#pendingExtraLoads--;
    });
  }

  unloadExtra(name: string): Promise<Record<string, ExtraStatus>> {
    assertExtraName(name);
    this.#extraNameEpoch.set(name, (this.#extraNameEpoch.get(name) ?? 0) + 1);
    const active = this.#active;
    const interrupted = this.#interruptLoadingExtra(name);
    // 已加载实例也立即停止接收新任务，不让另一个插件的慢初始化延迟本次 abort。
    const localUnloading =
      this.#extraLocations.get(name) === "local"
        ? this.#localExtras?.plugins.unload(name)
        : undefined;
    void localUnloading?.catch(() => undefined);
    if (localUnloading) this.#emitExtraStatus();
    return this.#enqueue(async () => {
      await interrupted;
      if (active && this.#active !== active) throw new Error("EXTRA_ACCOUNT_CHANGED");
      let result: Record<string, ExtraStatus>;
      if (this.#extraLocations.get(name) === "local") {
        try {
          await (localUnloading ?? this.#localExtras!.plugins.unload(name));
        } finally {
          this.#emitExtraStatus();
        }
        result = this.#snapshot.extras ?? {};
      } else result = await this.#extraControl("extra.unload", { name });
      const descriptor = this.#extras.get(name);
      if (descriptor) this.#extras.set(name, { ...descriptor, enabled: false });
      return result;
    });
  }

  #interruptExtras(): Promise<void> | undefined {
    ++this.#extraEpoch;
    // .octospec/tasks/sdk-host-extra-contexts/flows.md：先 abort，再等待串行队列，避免初始化死锁。
    const extras = this.#localExtras;
    const active = this.#active;
    if (extras) {
      void extras
        .close()
        .catch(() => {
          this.#localCleanupFailed = true;
        })
        .finally(() => {
          if (this.#localExtras === extras && this.#active === active && active)
            this.#emitExtraStatus();
        });
      this.#emitExtraStatus();
    }
    return this.#interruptLoadingExtra();
  }

  #interruptLoadingExtra(name?: string): Promise<void> | undefined {
    const loading = this.#loadingExtra;
    if (!loading || (name !== undefined && loading.name !== name)) return undefined;
    loading.cancelled = true;
    if (loading.interrupt) return loading.interrupt;
    if (this.#extraLocations.get(loading.name) === "local") {
      loading.interrupt = this.#localExtras!.plugins.unload(loading.name).catch(() => undefined);
      return loading.interrupt;
    }
    // The load and stop use separate IPC connections. Observe acceptance before
    // sending unload, so a fast unload cannot overtake the load on the wire.
    const socket = loading.active.supervised.paths.socket;
    loading.interrupt = (async () => {
      while (!loading.finished) {
        const status = await callDaemon<Record<string, ExtraStatus>>(socket, {
          method: "extra.status"
        });
        if (loading.finished) return;
        if (status[loading.name]?.phase === "loading" || status[loading.name]?.phase === "loaded") {
          await callDaemon(
            socket,
            { method: "extra.unload", params: { name: loading.name } },
            60_000
          );
          return;
        }
        await Promise.race([
          loading.settled,
          new Promise<void>((resolve) => setTimeout(resolve, 10))
        ]);
      }
    })().catch(() => {
      // The serialized unload/drain below reports the final cleanup result.
    });
    return loading.interrupt;
  }

  extraStatus(): Promise<Record<string, ExtraStatus>>;
  extraStatus(name: string): Promise<JsonObject>;
  extraStatus(name?: string): Promise<Record<string, ExtraStatus> | JsonObject> {
    if (name === undefined) return this.#enqueue(() => this.#extraControl("extra.status", {}));
    assertExtraName(name);
    return this.#enqueue(async () => {
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      if (this.#extraLocations.get(name) === "local")
        return this.#localExtras!.plugins.inspect(name);
      return callDaemon<JsonObject>(
        this.#active.supervised.paths.socket,
        {
          method: "extra.status",
          params: { name }
        },
        60_000
      );
    });
  }

  async #extraControl(
    method: string,
    params: Record<string, unknown>
  ): Promise<Record<string, ExtraStatus>> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    const result = await callDaemon<Record<string, ExtraStatus>>(
      this.#active.supervised.paths.socket,
      { method, params },
      60_000
    );
    const merged = this.#mergeExtraStatus(result);
    this.#emitExtraStatus(merged);
    return merged;
  }

  #mergeExtraStatus(remote: Record<string, ExtraStatus>): Record<string, ExtraStatus> {
    const result = { ...remote };
    for (const [name, status] of Object.entries(this.#localExtras?.plugins.status ?? {})) {
      if (this.#extraLocations.get(name) === "local") result[name] = status;
    }
    return result;
  }

  #emitExtraStatus(status = this.#mergeExtraStatus(this.#snapshot.extras ?? {})): void {
    this.#emit({ ...this.#snapshot, extras: status, observedAt: Date.now() });
  }

  startModule(id: string, config: unknown): Promise<unknown> {
    const snapshot = structuredClone(config);
    return this.#enqueue(async () => {
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      if (this.#extraLocations.get(id) === "local") throw new Error("EXTRA_MODULE_NAME_CONFLICT");
      return callDaemon(this.#active.supervised.paths.socket, {
        method: "module.start",
        params: { id, config: snapshot }
      });
    });
  }

  stopModule(id: string): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#active) throw new Error("HOST_NOT_RUNNING");
      await callDaemon(this.#active.supervised.paths.socket, {
        method: "module.stop",
        params: { id }
      });
    });
  }

  requestModule<T = unknown>(
    id: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    const snapshot = params ? structuredClone(params) : undefined;
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon<T>(
      this.#active.supervised.paths.socket,
      { method: "module.request", params: { id, method, params: snapshot } },
      60_000
    );
  }

  async *invokeFrames(
    input: InvokeInput,
    environment: InvokeEnvironment = {}
  ): AsyncGenerator<HostFrame> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    yield* invokeDaemonRun(this.#active.supervised.paths.socket, input, environment);
  }

  listAdapters(runtimeId?: string): Promise<HostedAdapterMetadata[]> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, {
      method: "adapter.list",
      params: runtimeId ? { runtimeId } : undefined
    });
  }

  cancelRun(runId: string): Promise<{ cancelled: boolean }> {
    if (!this.#active) return Promise.reject(new Error("HOST_NOT_RUNNING"));
    return callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.cancel",
      params: { run_id: runId }
    });
  }

  async respondRun(runId: string, response: InteractionResponse): Promise<void> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    await callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.respond",
      params: { run_id: runId, response }
    });
  }
  async respondNativeRun(runId: string, response: NativeInteractionResponse): Promise<void> {
    if (!this.#active) throw new Error("HOST_NOT_RUNNING");
    await callDaemon(this.#active.supervised.paths.socket, {
      method: "agent_run.native.respond",
      params: { run_id: runId, response }
    });
  }

  async *subscribeRun(input: {
    runId: string;
    streamId?: string;
    afterSeq?: number;
    signal?: AbortSignal;
  }): AsyncIterable<Record<string, unknown>> {
    const active = this.#active;
    if (!active) throw new Error("HOST_NOT_RUNNING");
    yield* subscribeDaemonRun(active.supervised.paths.socket, input);
  }

  onHealth(listener: (health: DaemonHealth) => void): () => void {
    this.#listeners.add(listener);
    this.#notify(listener, this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  async #startAccount(input: StartAccountOptions): Promise<DaemonHealth> {
    if (this.#localCleanupFailed) {
      if (this.#active) await this.#stop("reconfigure");
      throw new Error("EXTRA_DISPOSE_FAILED");
    }
    const tenants = validateTenants(input.tenants);
    const accountKey = accountKeyFor(input.subject.type, input.subject.id);
    const signature = tenantSignature(accountKey, tenants);
    if (this.#active?.signature === signature) {
      this.#active.input = { ...input, tenants };
      const status = await runtimeStatus(this.#active.supervised);
      if (status?.ready) {
        this.#applyDaemonStatus(status);
        return this.#snapshot;
      }
      await this.#stop("reconfigure");
    }
    if (this.#active)
      await this.#stop(
        accountKeyFor(this.#active.input.subject.type, this.#active.input.subject.id) === accountKey
          ? "reconfigure"
          : "account-switch"
      );

    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#abort = abort;
    this.#emit({
      ...emptyHealth(this.#paths.home, generation),
      phase: "preparing-home",
      accountKey
    });
    let lock: OwnerLock | undefined;
    try {
      lock = acquireOwnerLock(this.#paths);
      this.#ownerLock = lock;
      const machine = ensureDaemonHome(this.#paths);
      const account = accountPaths(this.#paths, accountKey);
      const tenantProfiles = new Map(
        tenants.map((tenant) => [tenant.id, profileNameFor(this.#options.appId, tenant.id)])
      );
      ensureAccount(account, [...tenantProfiles.values()]);
      this.#emit({
        ...this.#snapshot,
        machineId: machine.machine_id,
        profiles: tenants.map((tenant) => ({
          ...profileHealth(tenant.id, tenantProfiles.get(tenant.id)!, "offline"),
          runtimeId: ensureLocalRuntime(
            profilePaths(account, tenantProfiles.get(tenant.id)!),
            tenant
          ).runtime_id
        })),
        observedAt: Date.now()
      });

      this.#emit({ ...this.#snapshot, phase: "starting", observedAt: Date.now() });
      const started = await startManagedDaemon({
        sdk: { ...this.#options, extras: [...this.#extras.values()] },
        paths: this.#paths,
        account,
        profiles: [...tenantProfiles.values()],
        subject: input.subject,
        nonce: lock.nonce
      });
      this.#active = {
        input: { ...input, tenants },
        account,
        tenantProfiles,
        supervised: started.supervised,
        signature
      };
      const active = this.#active;
      this.#localExtras = new LocalExtras(
        active.supervised.paths.socket,
        () => this.#active === active && generation === this.#generation && !abort.signal.aborted,
        this.#options.logging
      );
      started.supervised.child.once("exit", () => {
        if (
          generation !== this.#generation ||
          this.#snapshot.phase === "stopping" ||
          this.#snapshot.phase === "stopped"
        )
          return;
        void this.#interruptExtras();
        this.#emitError(
          new DaemonRuntimeError(
            "DAEMON_EXITED",
            "daemon",
            true,
            "embedded runtime exited unexpectedly"
          )
        );
      });
      this.#applyDaemonStatus(started.status);
      this.#pollTimer = setInterval(() => {
        void this.#refreshHealth();
      }, this.#options.healthPollIntervalMs ?? 5_000);
      this.#pollTimer.unref();
      return this.#snapshot;
    } catch (error) {
      abort.abort(error);
      if (!this.#active) {
        lock?.release();
        if (this.#ownerLock === lock) this.#ownerLock = undefined;
      }
      const embeddedError = asDaemonRuntimeError(error, {
        code: "START_FAILED",
        scope: "daemon",
        retryable: true
      });
      this.#emitError(embeddedError);
      throw embeddedError;
    }
  }

  async #stop(reason: "logout" | "account-switch" | "quit" | "reconfigure"): Promise<void> {
    ++this.#generation;
    this.#abort?.abort(new Error(`embedded account stopped: ${reason}`));
    this.#abort = undefined;
    if (this.#pollTimer) clearInterval(this.#pollTimer);
    this.#pollTimer = undefined;
    const active = this.#active;
    this.#emit({ ...this.#snapshot, phase: "stopping", observedAt: Date.now() });
    let cleanupError: DaemonRuntimeError | undefined;
    if (this.#localExtras) {
      try {
        await this.#localExtras.close();
      } catch {
        this.#localCleanupFailed = true;
        cleanupError = new DaemonRuntimeError(
          "EXTRA_DISPOSE_FAILED",
          "shutdown",
          false,
          "Extra cleanup failed"
        );
      }
      if (!this.#localCleanupFailed) this.#localExtras = undefined;
    }
    if (active) {
      try {
        await stopManagedDaemon(active.supervised);
      } catch (error) {
        if (!(error instanceof DaemonRuntimeError) || error.code !== "EXTRA_DISPOSE_FAILED")
          throw error;
        cleanupError = error;
      }
    }
    this.#active = undefined;
    if (reason === "logout" || reason === "account-switch") {
      this.#extras.clear();
      this.#extraLocations.clear();
      for (const descriptor of this.#options.extras ?? [])
        this.#extras.set(descriptor.name, structuredClone(descriptor));
    }
    for (const [name, location] of this.#extraLocations) {
      if (location === "local") this.#extraLocations.delete(name);
    }
    this.#ownerLock?.release();
    this.#ownerLock = undefined;
    this.#emit({
      ...emptyHealth(this.#paths.home, this.#generation),
      phase: "stopped"
    });
    if (cleanupError) throw cleanupError;
  }

  async #refreshHealth(): Promise<void> {
    const active = this.#active;
    if (!active) return;
    const status = await runtimeStatus(active.supervised);
    if (
      active !== this.#active ||
      this.#snapshot.phase === "stopping" ||
      this.#snapshot.phase === "stopped"
    )
      return;
    if (!status) {
      void this.#interruptExtras();
      this.#emitError(
        new DaemonRuntimeError(
          "DAEMON_UNREACHABLE",
          "daemon",
          true,
          "embedded daemon is not reachable"
        )
      );
      return;
    }
    this.#applyDaemonStatus(status);
  }

  #applyDaemonStatus(status: Awaited<ReturnType<typeof runtimeStatus>> & {}): void {
    const profiles = this.#snapshot.profiles.map((profile) => ({
      ...profile,
      state: status.ready ? ("ready" as const) : ("offline" as const),
      observedAt: Date.now()
    }));
    this.#emit({
      ...this.#snapshot,
      phase: status.ready === true ? "running" : "error",
      local: {
        ready: status.ready === true,
        pid: status.pid,
        adapterHostReady: status.adapterHost?.state === "ready",
        socketReachable: true
      },
      modules: status.modules ?? {},
      extras: this.#mergeExtraStatus(status.extras ?? {}),
      profiles,
      problem: undefined,
      observedAt: Date.now()
    });
  }

  #emitError(error: DaemonRuntimeError): void {
    const problem: DaemonProblem = {
      code: error.code,
      scope: error.scope,
      retryable: error.retryable,
      message: error.message
    };
    this.#emit({ ...this.#snapshot, phase: "error", problem, observedAt: Date.now() });
  }

  #emit(health: DaemonHealth): void {
    this.#snapshot = health;
    for (const listener of this.#listeners) this.#notify(listener, health);
  }

  #notify(listener: (health: DaemonHealth) => void, health: DaemonHealth): void {
    try {
      listener(health);
    } catch {
      // Consumers cannot break lifecycle progress.
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function emptyHealth(home: string, generation = 0): DaemonHealth {
  return {
    phase: "idle",
    generation,
    home,
    local: { ready: false, adapterHostReady: false, socketReachable: false },
    modules: {},
    profiles: [],
    observedAt: Date.now()
  };
}

function profileHealth(
  tenantId: string,
  profile: string,
  state: ProfileHealth["state"]
): ProfileHealth {
  return { tenantId, profile, state, observedAt: Date.now() };
}

function validateTenants(tenants: readonly AuthorizedTenant[]): AuthorizedTenant[] {
  if (tenants.length === 0)
    throw new DaemonRuntimeError(
      "TENANTS_EMPTY",
      "home",
      false,
      "at least one authorized tenant is required"
    );
  const ids = new Set<string>();
  return tenants.map((tenant) => {
    const id = tenant.id.trim();
    if (!id || ids.has(id))
      throw new DaemonRuntimeError(
        "TENANT_INVALID",
        "home",
        false,
        `tenant id is empty or duplicated: ${id}`
      );
    ids.add(id);
    return { ...tenant, id };
  });
}

function tenantSignature(accountKey: string, tenants: readonly AuthorizedTenant[]): string {
  return JSON.stringify([
    accountKey,
    ...tenants
      .map((tenant) => [tenant.id, tenant.name ?? ""])
      .sort((left, right) => left[0].localeCompare(right[0]))
  ]);
}
